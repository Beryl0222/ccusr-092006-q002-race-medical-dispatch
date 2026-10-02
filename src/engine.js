// 编排引擎：命令 → 事件。所有决策都留痕（ADJUSTMENT / INCIDENT_*），
// 管理端可据此解释每一次资源冲突与调整。

import { CONFLICT_CODES, NOTICE_TYPES, SIGNER_ROLES } from "./domain.js";
import { MIN, overlap } from "./time.js";
import { normForWindow, NORMS } from "./norms.js";
import { buildGraph, schedulePosts } from "./scheduler.js";
import { INCIDENT_HOLD_MIN, resolveIncident } from "./resolve.js";

const requireNorm = (id) => NORMS.find((n) => n.norm_id === id) ?? null;

export class Engine {
  constructor(store) {
    this.store = store;
  }

  #nowId = 0;
  #id(base, suffix = "") {
    this.#nowId += 1;
    return `${base}${suffix ? `#${suffix}` : ""}`;
  }

  #emit(kind, occurredAt, payload, { partition = "main" } = {}) {
    const eventId = payload.event_id ?? this.#id(kind.toLowerCase(), this.#nowId);
    const clean = { ...payload };
    delete clean.event_id;
    const event = {
      event_id: eventId,
      kind,
      occurred_at: occurredAt,
      subject_id: clean.subject_id ?? clean.plan_id ?? clean.incident_id ?? clean.notice_id ?? "system",
      payload: clean,
    };
    return this.store.append(event, partition === "phi" ? { partition: "phi" } : undefined);
  }

  handle(cmd) {
    if (!cmd?.kind || !cmd.occurred_at || !cmd.command_id) {
      return { ok: false, conflicts: [{ code: CONFLICT_CODES.BAD_COMMAND, detail: "缺少 kind/occurred_at/command_id" }] };
    }
    const prior = this.store.commandSeen(cmd.command_id);
    if (prior) return { ok: true, replayed: true, events: prior };

    switch (cmd.kind) {
      case "declare_resource":
        return this.#declare(cmd);
      case "resource_notice":
        return this.#notice(cmd);
      case "submit_plan":
        return this.#submitPlan(cmd);
      case "approve_plan":
        return this.#approvePlan(cmd);
      case "withdraw_plan":
        return this.#withdraw(cmd);
      case "report_incident":
        return this.#incident(cmd);
      case "complete_handoff":
        return this.#handoff(cmd);
      case "record_phi":
        return this.#recordPhi(cmd);
      default:
        return { ok: false, conflicts: [{ code: CONFLICT_CODES.BAD_COMMAND, detail: `未知命令 ${cmd.kind}` }] };
    }
  }

  #declare(cmd) {
    const r = cmd.resource;
    if (!r?.id || !r.kind || !r.owner_org)
      return { ok: false, conflicts: [{ code: CONFLICT_CODES.BAD_COMMAND, detail: "资源缺少 id/kind/owner_org" }] };
    const payload = { command_id: cmd.command_id, resource: r };
    const event = this.#emit("RESOURCE_DECLARED", cmd.occurred_at, payload);
    return { ok: true, events: [event] };
  }

  // ---------- 方案提交 / 审批 ----------

  #submitPlan(cmd) {
    const state = this.#snapshot(Date.parse(cmd.occurred_at));
    if (state.plans.has(cmd.plan.plan_id))
      return { ok: false, conflicts: [{ code: CONFLICT_CODES.BAD_COMMAND, detail: "plan_id 已存在" }] };
    const event = this.#emit("PLAN_SUBMITTED", cmd.occurred_at, {
      command_id: cmd.command_id,
      plan: this.#normalizePlan(cmd.plan),
      submitted_by: cmd.actor,
    });
    return { ok: true, events: [event] };
  }

  #withdraw(cmd) {
    const state = this.#snapshot(Date.parse(cmd.occurred_at));
    const plan = state.plans.get(cmd.plan_id);
    if (!plan || plan.status === "approved")
      return { ok: false, conflicts: [{ code: CONFLICT_CODES.PLAN_NOT_ACTIVE, detail: "方案不存在或已生效（生效方案不可撤回，须走变更）" }] };
    const event = this.#emit("PLAN_WITHDRAWN", cmd.occurred_at, {
      command_id: cmd.command_id,
      plan_id: cmd.plan_id,
      actor: cmd.actor,
    });
    return { ok: true, events: [event] };
  }

  #normalizePlan(plan) {
    return {
      ...plan,
      posts: plan.posts.map((p) => ({
        ...p,
        setup: p.setup ?? plan.setup ?? undefined,
        teardown: p.teardown ?? plan.teardown ?? undefined,
      })),
      links: plan.links ?? [],
    };
  }

  #approvePlan(cmd) {
    const at = Date.parse(cmd.occurred_at);
    const state = this.#snapshot(at);
    const entry = state.plans.get(cmd.plan_id);
    const reject = (conflicts) => {
      const event = this.#emit("PLAN_APPROVED", cmd.occurred_at, {
        command_id: cmd.command_id,
        plan_id: cmd.plan_id,
        decision: "rejected",
        signer: cmd.signer,
        conflicts,
      });
      return { ok: false, rejected: true, events: [event], conflicts };
    };

    if (!entry || entry.status !== "submitted")
      return { ok: false, conflicts: [{ code: CONFLICT_CODES.PLAN_NOT_ACTIVE, detail: "方案不存在或未处于待签状态" }] };
    if (!cmd.signer || !SIGNER_ROLES.includes(cmd.signer.role))
      // 无权签署：动作不予受理，不改变方案状态（仍可由有权人员签署）
      return {
        ok: false,
        conflicts: [{ code: CONFLICT_CODES.UNSIGNED_OR_UNAUTHORIZED, signer: cmd.signer, detail: "签署人不是赛事安全负责人或医疗主管" }],
      };

    const plan = entry.plan;
    const coverStarts = plan.posts.map((p) => Date.parse(p.setup?.start ?? p.window.start));
    const coverEnds = plan.posts.map((p) => Date.parse(p.teardown?.end ?? p.window.end));
    const norm = normForWindow(Math.min(...coverStarts), Math.max(...coverEnds));
    if (!norm || norm.norm_id !== plan.norm_id)
      return reject([
        {
          code: CONFLICT_CODES.NORM_VERSION_MISMATCH,
          cited: plan.norm_id,
          current: norm?.norm_id ?? null,
          detail: "方案引用规范未覆盖整个布撤场窗口，必须按当前规范重编",
        },
      ]);

    // 布撤场窗口必须包含规范要求的前置/后置缓冲
    const bufferConflicts = [];
    for (const p of plan.posts) {
      const dutyS = Date.parse(p.window.start);
      const dutyE = Date.parse(p.window.end);
      const setupS = Date.parse(p.setup?.start ?? new Date(dutyS - norm.setup_buffer_min * MIN).toISOString());
      const teardownE = Date.parse(p.teardown?.end ?? new Date(dutyE + norm.teardown_buffer_min * MIN).toISOString());
      if (p.setup && dutyS - setupS < norm.setup_buffer_min * MIN)
        bufferConflicts.push({ code: CONFLICT_CODES.WINDOW_UNCOVERED, post_id: p.id, phase: "setup", need_min: norm.setup_buffer_min });
      if (p.teardown && teardownE - dutyE < norm.teardown_buffer_min * MIN)
        bufferConflicts.push({ code: CONFLICT_CODES.WINDOW_UNCOVERED, post_id: p.id, phase: "teardown", need_min: norm.teardown_buffer_min });
    }
    if (bufferConflicts.length) return reject(bufferConflicts);

    const { posts, resources, graph } = this.#preparePlan(plan, state, norm);
    const occupied = this.#baseOccupied(state, at, { excludePlan: plan.plan_id });
    const result = schedulePosts(posts, {
      resources,
      graph,
      norm,
      occupied,
      heatFor: () => false,
    });
    if (result.conflicts.length) return reject(result.conflicts);

    const assignments = [...result.assignments.values()];
    const approved = this.#emit("PLAN_APPROVED", cmd.occurred_at, {
      command_id: cmd.command_id,
      plan_id: plan.plan_id,
      decision: "approved",
      signer: cmd.signer,
      norm_id: norm.norm_id,
    });
    const adjustment = this.#emit("ADJUSTMENT", cmd.occurred_at, {
      command_id: `${cmd.command_id}:initial`,
      plan_id: plan.plan_id,
      reason: "INITIAL",
      affected_post_ids: assignments.map((a) => a.post_id),
      before: {},
      after: Object.fromEntries(assignments.map((a) => [a.post_id, a])),
      heat_scopes: [],
      note: "方案签署生效，初始编排",
    });
    return { ok: true, events: [approved, adjustment], assignments };
  }

  #preparePlan(plan, state, norm) {
    const resources = new Map(state.resources);
    const links = [];
    for (const e of state.plans.values()) if (e.status === "approved") links.push(...(e.plan.links ?? []));
    links.push(...(plan.links ?? []));
    const posts = plan.posts.map((p) => {
      const dutyS = Date.parse(p.window.start);
      const dutyE = Date.parse(p.window.end);
      const cover = {
        start: Date.parse(p.setup?.start ?? new Date(dutyS - norm.setup_buffer_min * MIN).toISOString()),
        end: Date.parse(p.teardown?.end ?? new Date(dutyE + norm.teardown_buffer_min * MIN).toISOString()),
      };
      return { ...p, _plan: plan.plan_id, coverWindow: cover };
    });
    return { posts, resources, graph: buildGraph(links) };
  }

  // ---------- 通知：高温 / 证照 / 故障 / 路线 ----------

  #notice(cmd) {
    const n = cmd.notice;
    if (!n?.notice_id || !NOTICE_TYPES.includes(n.type))
      return { ok: false, conflicts: [{ code: CONFLICT_CODES.BAD_COMMAND, detail: "通知缺少 notice_id 或类型非法" }] };

    const dup = this.store.noticeHandled(n.notice_id);
    if (dup) {
      let suppressed = this.store.events.find(
        (e) => e.kind === "NOTICE_SUPPRESSED" && e.payload?.notice_id === n.notice_id,
      );
      if (!suppressed) {
        suppressed = this.#emit("NOTICE_SUPPRESSED", cmd.occurred_at, {
          event_id: `supp#${n.notice_id}`,
          notice_id: n.notice_id,
          type: n.type,
          original_event_id: dup.event_id,
          detail: "重复通知不再生成第二份任务",
        });
      }
      return { ok: true, duplicated: true, events: [suppressed] };
    }

    const at = Date.parse(cmd.occurred_at);
    const state = this.#snapshot(at);
    const resource = n.resource_id ? state.resources.get(n.resource_id) : null;
    if (n.type !== "HEAT") {
      if (!resource) return { ok: false, conflicts: [{ code: CONFLICT_CODES.BAD_COMMAND, detail: "通知涉及的资源不存在" }] };
      if (cmd.actor?.org !== resource.owner_org)
        return {
          ok: false,
          conflicts: [{ code: CONFLICT_CODES.OWNER_SCOPE, resource_id: resource.id, owner_org: resource.owner_org, actor_org: cmd.actor?.org }],
        };
    }

    // 设备/路线/证照：先落资源状态变更
    if (n.type !== "HEAT") {
      const patch = this.#patchFor(n, resource);
      this.#emit("RESOURCE_STATUS_CHANGED", cmd.occurred_at, {
        event_id: `rsc#${n.notice_id}`,
        notice_id: n.notice_id,
        resource_id: resource.id,
        patch,
        actor: cmd.actor,
      });
    }

    const fresh = this.#snapshot(at);
    const winS = Date.parse(n.window?.[0] ?? cmd.occurred_at);
    const winE = Date.parse(n.window?.[1] ?? cmd.occurred_at);
    const affected = this.#affectedPosts(n, fresh, winS, winE);
    return this.#reschedule({
      cmd,
      notice: n,
      at,
      state: fresh,
      affected,
      winS,
      winE,
      reason: n.type,
    });
  }

  #patchFor(n, resource) {
    if (n.type === "EQUIPMENT_FAULT") return { status: "fault", fault_windows: [n.window] };
    if (n.type === "ROUTE_CHANGE") return { closed_windows: n.closed_windows ?? [n.window], status: n.status ?? resource.status };
    // 关键证照到期 → 记录成员变化，同时班组在通知窗口内停止独立执勤（离场，等待顶岗）
    if (n.type === "CERT_EXPIRY") return { member_patch: n.member_patch, away_windows: [n.window] };
    return {};
  }

  #affectedPosts(n, state, winS, winE) {
    const current = state.assignments;
    const hitWindow = (p) => overlap(winS, winE, p.coverWindow.start, p.coverWindow.end);
    const posts = state.allPosts.filter(hitWindow);
    if (n.type === "HEAT") {
      const scope = n.scope ?? {};
      return posts.filter((p) => {
        if (scope.post_ids?.includes(p.id)) return true;
        if (scope.activity_ids?.includes(p.activity_id)) return true;
        if (scope.region && p.region === scope.region) return true;
        return false;
      });
    }
    if (n.type === "CERT_EXPIRY")
      return posts.filter((p) => current.get(p.id)?.team_id === n.resource_id);
    if (n.type === "EQUIPMENT_FAULT")
      return posts.filter((p) => current.get(p.id)?.aed_id === n.resource_id);
    if (n.type === "ROUTE_CHANGE")
      return posts.filter((p) => current.get(p.id)?.chain?.route_id === n.resource_id);
    return [];
  }

  #reschedule({ cmd, notice, at, state, affected, winS, winE, reason }) {
    const before = Object.fromEntries(affected.map((p) => [p.id, state.assignments.get(p.id) ?? null]));
    const heatScopes = [...state.heatScopes];
    if (reason === "HEAT") heatScopes.push({ scope: notice.scope ?? {}, window: [winS, winE] });

    const norm = state.normAt(at);
    const occupied = this.#baseOccupied(state, at, { excludePostIds: new Set(affected.map((p) => p.id)) });
    // 进行中的突发事件占用仍然锁定
    for (const inc of state.incidents.values()) {
      if (!inc.engagement) continue;
      const [s, e] = inc.engagement.window;
      if (overlap(s, e, winS, winE)) {
        for (const id of inc.engagement.resources) occupied.set(id, [...(occupied.get(id) ?? []), { s, e, post_id: `incident:${inc.incident_id}` }]);
      }
    }

    const preferSlots = new Map();
    for (const p of affected) {
      const cur = state.assignments.get(p.id);
      if (cur) preferSlots.set(p.id, { team_id: cur.team_id, aed_id: cur.aed_id });
    }

    const result = schedulePosts(affected, {
      resources: state.resources,
      graph: state.graph,
      norm,
      occupied,
      preferSlots,
      heatFor: (p) => heatScopes.some((h) => this.#inHeat(h, p, winS, winE)),
    });

    const after = Object.fromEntries(affected.map((p) => [p.id, result.assignments.get(p.id) ?? null]));
    const events = [];
    events.push(
      this.#emit("ADJUSTMENT", cmd.occurred_at, {
        event_id: `adj#${notice.notice_id}`,
        notice_id: notice.notice_id,
        reason,
        affected_post_ids: affected.map((p) => p.id),
        before,
        after,
        heat_scopes: reason === "HEAT" ? [{ scope: notice.scope ?? {}, window: notice.window }] : [],
        conflicts: result.conflicts,
        detail: notice.detail ?? null,
      }),
    );
    // 未覆盖岗位立即升级留痕（即使非突发事件，缺口也要可见）
    for (const p of affected) {
      if (!result.assignments.get(p.id)) {
        events.push(
          this.#emit("INCIDENT_ESCALATED", cmd.occurred_at, {
            event_id: `esc#gap#${notice.notice_id}#${p.id}`,
            incident_id: null,
            post_id: p.id,
            escalation: "COVERAGE_GAP",
            reason,
            conflicts: result.conflicts.filter((c) => c.post_id === p.id),
          }),
        );
      }
    }
    return { ok: !result.conflicts.length, events, affected: after, conflicts: result.conflicts };
  }

  #inHeat(h, p, s, e) {
    const match =
      h.scope.post_ids?.includes(p.id) || h.scope.activity_ids?.includes(p.activity_id) || (h.scope.region && p.region === h.scope.region);
    return !!match && overlap(s, e, h.window[0], h.window[1]);
  }

  // ---------- 突发事件：立即接手 / 抢占 / 补位 / 升级 ----------

  #incident(cmd) {
    const at = Date.parse(cmd.occurred_at);
    const state = this.#snapshot(at);
    const inc = cmd.incident;
    const post = state.allPosts.find((p) => p.id === inc.post_id);
    if (!post || !overlap(at, at + 1, post.coverWindow.start, post.coverWindow.end))
      return { ok: false, conflicts: [{ code: CONFLICT_CODES.PLAN_NOT_ACTIVE, post_id: inc.post_id, detail: "该时刻无生效方案覆盖此点位" }] };

    const engagedVehicles = new Set();
    for (const other of state.incidents.values()) {
      if (other.engagement && other.id !== inc.incident_id && other.engagement.vehicle_id)
        engagedVehicles.add(other.engagement.vehicle_id);
    }
    const decision = resolveIncident(state, { post, injury: inc.injury, at, engagedVehicles });
    const events = [];

    // 抢占 → 同步写补位调整与升级记录（补不到也要留痕）
    for (const pre of decision.preempts) {
      events.push(
        this.#emit("ADJUSTMENT", cmd.occurred_at, {
          event_id: `adj#preempt-${pre.kind}#${inc.incident_id}`,
          reason: "EMERGENCY_PREEMPT",
          incident_id: inc.incident_id,
          affected_post_ids: [pre.donor_post_id],
          before: { [pre.donor_post_id]: state.assignments.get(pre.donor_post_id) },
          after: { [pre.donor_post_id]: pre.replacement },
          preempt: { resource_kind: pre.kind, resource_id: pre.resource_id, from_post_id: pre.donor_post_id, to_post_id: post.id, eta_min: pre.eta_min },
          conflicts: pre.conflicts,
        }),
      );
      events.push(
        this.#emit("INCIDENT_ESCALATED", cmd.occurred_at, {
          event_id: `esc#preempt-${pre.kind}#${inc.incident_id}`,
          incident_id: inc.incident_id,
          post_id: pre.donor_post_id,
          escalation: pre.replacement ? "PREEMPTED_WITH_BACKFILL" : "NO_BACKFILL",
          resource_kind: pre.kind,
          borrowed_resource_id: pre.resource_id,
          backfill: pre.replacement
            ? { post_id: pre.donor_post_id, team_id: pre.replacement.team_id, aed_id: pre.replacement.aed_id }
            : null,
          conflicts: pre.conflicts,
        }),
      );
    }

    events.push(
      this.#emit("INCIDENT_OPENED", cmd.occurred_at, {
        command_id: cmd.command_id,
        incident_id: inc.incident_id,
        post_id: post.id,
        activity_id: post.activity_id,
        injury: inc.injury,
        severity: inc.severity,
        location_ref: inc.location_ref ?? post.ref,
        decision,
        engagement: {
          vehicle_id: decision.chain?.vehicle_id ?? null,
          resources: [decision.team_id, decision.aed_id].filter(Boolean),
          window: [at, at + INCIDENT_HOLD_MIN * MIN],
        },
      }),
    );

    if (decision.conflicts.length) {
      events.push(
        this.#emit("INCIDENT_ESCALATED", cmd.occurred_at, {
          event_id: `esc#${inc.incident_id}`,
          incident_id: inc.incident_id,
          post_id: post.id,
          escalation: "RESPONSE_GAP",
          conflicts: decision.conflicts,
        }),
      );
    }
    return { ok: decision.conflicts.length === 0, events, decision };
  }

  #handoff(cmd) {
    const at = Date.parse(cmd.occurred_at);
    const state = this.#snapshot(at);
    const inc = state.incidents.get(cmd.incident_id);
    if (!inc) return { ok: false, conflicts: [{ code: CONFLICT_CODES.BAD_COMMAND, detail: "突发事件不存在" }] };
    if (inc.handoff) return { ok: false, conflicts: [{ code: CONFLICT_CODES.DUPLICATE_TASK, detail: "该事件已有交接记录" }] };
    const event = this.#emit("HANDOFF_COMPLETED", cmd.occurred_at, {
      command_id: cmd.command_id,
      incident_id: cmd.incident_id,
      facility_id: cmd.facility_id,
      arrived_at: cmd.arrived_at,
      accepted: cmd.accepted ?? true,
      phi_ref: cmd.phi_ref ?? null, // 仅引用；健康资料本体只在 PHI 分区
      actor: cmd.actor,
    });
    return { ok: true, events: [event] };
  }

  #recordPhi(cmd) {
    const phi = cmd.phi;
    if (!phi?.phi_id || !phi.incident_id || !phi.content)
      return { ok: false, conflicts: [{ code: CONFLICT_CODES.BAD_COMMAND, detail: "PHI 缺少 phi_id/incident_id/content" }] };
    if (cmd.actor?.org !== "hospital")
      return { ok: false, conflicts: [{ code: CONFLICT_CODES.PHI_SCOPE, detail: "只有接诊医院可写入 PHI 分区" }] };
    const event = this.#emit(
      "PHI_RECORDED",
      cmd.occurred_at,
      { event_id: `phi#${phi.phi_id}`, command_id: cmd.command_id, phi_id: phi.phi_id, incident_id: phi.incident_id, content: phi.content, actor: cmd.actor },
      { partition: "phi" },
    );
    return { ok: true, events: [event], partition: "phi" };
  }

  // ---------- 状态投影 ----------

  #baseOccupied(state, at, { excludePlan = null, excludePostIds = new Set() } = {}) {
    const occupied = new Map();
    for (const [postId, asg] of state.assignments) {
      const p = state.postById.get(postId);
      if (!p || excludePostIds.has(postId)) continue;
      if (excludePlan && p._plan === excludePlan) continue;
      const w = { s: p.coverWindow.start, e: p.coverWindow.end, post_id: postId };
      occupied.set(asg.team_id, [...(occupied.get(asg.team_id) ?? []), w]);
      if (asg.aed_id) occupied.set(asg.aed_id, [...(occupied.get(asg.aed_id) ?? []), w]);
    }
    return occupied;
  }

  snapshotAt(asOfMs) {
    return this.#snapshot(asOfMs);
  }

  #snapshot(asOf) {
    const events = this.store.read({ asOf });
    const resources = new Map();
    const plans = new Map();
    const adjustments = [];
    const incidents = new Map();
    const escalations = [];

    const mergePatch = (r, patch) => {
      const out = { ...r };
      if (patch.status) out.status = patch.status;
      for (const key of ["fault_windows", "closed_windows", "away_windows"])
        if (patch[key]) out[key] = [...(out[key] ?? []), ...patch[key]];
      if (patch.member_patch) {
        out.members = (out.members ?? []).map((m) =>
          m.member_id === patch.member_patch.member_id || m.id === patch.member_patch.member_id ? { ...m, expires_at: patch.member_patch.expires_at } : m,
        );
      }
      return out;
    };

    for (const e of events) {
      const p = e.payload;
      switch (e.kind) {
        case "RESOURCE_DECLARED":
          resources.set(p.resource.id, { ...p.resource });
          break;
        case "RESOURCE_STATUS_CHANGED": {
          const r = resources.get(p.resource_id);
          if (r) resources.set(p.resource_id, mergePatch(r, p.patch));
          break;
        }
        case "PLAN_SUBMITTED":
          plans.set(p.plan.plan_id, { status: "submitted", plan: p.plan, submitted_at: e.occurred_at });
          break;
        case "PLAN_APPROVED":
          if (plans.has(p.plan_id)) {
            const entry = plans.get(p.plan_id);
            entry.status = p.decision === "approved" ? "approved" : "rejected";
            entry.decision = p;
          }
          break;
        case "PLAN_WITHDRAWN":
          if (plans.has(p.plan_id)) plans.get(p.plan_id).status = "withdrawn";
          break;
        case "ADJUSTMENT":
          adjustments.push({ ...p, at: Date.parse(e.occurred_at), event_id: e.event_id });
          break;
        case "INCIDENT_OPENED": {
          incidents.set(p.incident_id, {
            id: p.incident_id,
            incident_id: p.incident_id,
            opened: p,
            opened_at: Date.parse(e.occurred_at),
            engagement: p.engagement,
            handoff: null,
          });
          break;
        }
        case "HANDOFF_COMPLETED":
          if (incidents.has(p.incident_id)) {
            incidents.get(p.incident_id).handoff = p;
            incidents.get(p.incident_id).engagement = null;
          }
          break;
        case "INCIDENT_ESCALATED":
          escalations.push({ at: Date.parse(e.occurred_at), ...p });
          if (p.incident_id && incidents.has(p.incident_id)) {
            const inc = incidents.get(p.incident_id);
            inc.escalations = [...(inc.escalations ?? []), p];
          }
          break;
      }
    }

    // 点位（仅已生效方案）
    const allPosts = [];
    const links = [];
    for (const entry of plans.values()) {
      if (entry.status !== "approved") continue;
      links.push(...(entry.plan.links ?? []));
      const norm = normForWindow(
        Math.min(...entry.plan.posts.map((p) => Date.parse(p.setup?.start ?? p.window.start))),
        Math.max(...entry.plan.posts.map((p) => Date.parse(p.teardown?.end ?? p.window.end))),
      );
      for (const p0 of entry.plan.posts) {
        const dutyS = Date.parse(p0.window.start);
        const dutyE = Date.parse(p0.window.end);
        allPosts.push({
          ...p0,
          _plan: entry.plan.plan_id,
          coverWindow: {
            start: Date.parse(p0.setup?.start ?? new Date(dutyS - (norm?.setup_buffer_min ?? 0) * MIN).toISOString()),
            end: Date.parse(p0.teardown?.end ?? new Date(dutyE + (norm?.teardown_buffer_min ?? 0) * MIN).toISOString()),
          },
        });
      }
    }
    const postById = new Map(allPosts.map((p) => [p.id, p]));
    const graph = buildGraph(links);

    // 当前编排 = 顺序应用调整
    const assignments = new Map();
    const heatScopes = [];
    const trail = new Map();
    const note = (postId, rec) => {
      if (!trail.has(postId)) trail.set(postId, []);
      trail.get(postId).push(rec);
    };
    for (const a of adjustments) {
      if (a.reason === "INITIAL") {
        for (const [id, asg] of Object.entries(a.after)) {
          assignments.set(id, asg);
          note(id, { at: a.at, reason: "INITIAL", event_id: a.event_id, plan_id: a.plan_id });
        }
        continue;
      }
      if (a.reason === "HEAT") for (const h of a.heat_scopes ?? []) heatScopes.push({ scope: h.scope ?? {}, window: h.window.map(Date.parse) });
      for (const id of a.affected_post_ids ?? []) {
        const after = a.after?.[id] ?? null;
        if (after) assignments.set(id, after);
        else assignments.delete(id);
        note(id, {
          at: a.at,
          reason: a.reason,
          event_id: a.event_id,
          notice_id: a.notice_id ?? null,
          incident_id: a.incident_id ?? null,
          conflicts: a.conflicts?.filter((c) => c.post_id === id) ?? [],
        });
      }
    }

    // 进行中的资源占用
    const resourceEngaged = new Set();
    for (const inc of incidents.values()) {
      if (!inc.engagement) continue;
      if (overlap(asOf, asOf + 1, inc.engagement.window[0], inc.engagement.window[1]))
        for (const id of inc.engagement.resources ?? []) resourceEngaged.add(id);
    }

    // 当前生效方案签署时所用规范
    const normsById = new Map();
    for (const e of plans.values()) if (e.decision?.norm_id) normsById.set(e.decision.norm_id, requireNorm(e.decision.norm_id));

    return {
      asOf,
      resources,
      plans,
      adjustments,
      incidents,
      escalations,
      allPosts,
      postById,
      graph,
      assignments,
      heatScopes,
      trail,
      resourceEngaged,
      normAt: (ms) => normsById.values().next().value || normForWindow(ms, ms),
    };
  }
}
