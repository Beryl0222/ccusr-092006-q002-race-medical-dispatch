// 读模型视图：
// - drillView：演练人员按“指定时刻 + 点位 + 假设伤情”验证接手者与转运交接（只读推演）。
// - adminView：管理端解释资源冲突与每次调整（完整审计链）。
// - publicView：公开赛事视图（不含人员证照细节，绝不读取 PHI 分区）。

import { resolveIncident } from "./resolve.js";
import { iso } from "./time.js";

export const CONFLICT_TEXT = Object.freeze({
  NORM_VERSION_MISMATCH: "方案引用的规范版本已失效，须按现行规范重新编制后再签",
  UNSIGNED_OR_UNAUTHORIZED: "缺少有权人员签署（赛事安全负责人 / 医疗主管）",
  PLAN_NOT_ACTIVE: "该时刻无生效方案或该点位无在岗响应",
  CERT_MISSING: "救护队资质不满足该点位/伤情要求",
  CERT_EXPIRED: "队员证照在任务结束前到期",
  TEAM_SIZE: "救护队在岗人数低于规范下限",
  WINDOW_UNCOVERED: "布场/撤场缓冲不足，岗位窗口未被完整覆盖",
  TEAM_DOUBLE_BOOKED: "同一救护队在重叠时段被重复占用",
  AED_RESPONSE: "AED 到场时间超出规范限值（高温下限值更严）",
  AED_FAULT: "除颤设备处于故障/检修窗口",
  AED_UNAVAILABLE: "响应时限内无可用除颤设备",
  VEHICLE_UNAVAILABLE: "无同时满足车型、开放路线、医院能力与 ETA 的转运链路",
  VEHICLE_STRETCHER: "老年/担架伤情必须使用担架型救护车",
  ROUTE_CLOSED: "转运路线在该时段管制封闭",
  FACILITY_CAPABILITY: "目标医院缺少该伤情所需接诊能力",
  FACILITY_CLOSED: "预计到达时医院接诊窗口已关闭",
  OWNER_SCOPE: "资源只能由其归属机构（主办方/医院/急救站/志愿团队）维护",
  DUPLICATE_TASK: "重复通知/重复交接不得生成第二份任务",
  NO_BACKFILL: "资源被突发事件抢占后，原低风险点位暂无补位，已升级指挥中心",
  PHI_SCOPE: "个人健康资料只能进入 PHI 独立分区，且仅接诊医院可写",
  BAD_COMMAND: "命令结构不合法",
});

export function explain(code) {
  return CONFLICT_TEXT[code] ?? code;
}

const resLabel = (state, id) => state.resources.get(id)?.label ?? id;
const facWindow = (state, id) => state.resources.get(id)?.window ?? null;

// ---- 演练视图：指定时刻验证任一点位的响应者与转运交接 ----
export function drillView(engine, { at, post_id, injury }) {
  const atMs = Date.parse(at);
  const state = engine.snapshotAt(atMs);
  const post = state.postById.get(post_id) ?? state.allPosts.find((p) => p.id === post_id);
  if (!post) return { ok: false, at, post_id, conflicts: [{ code: "PLAN_NOT_ACTIVE", detail: "点位不存在或不属于任何生效方案" }] };

  const engagedVehicles = new Set();
  for (const inc of state.incidents.values()) {
    if (inc.engagement && inc.engagement.vehicle_id) engagedVehicles.add(inc.engagement.vehicle_id);
  }
  const decision = resolveIncident(state, { post, injury, at: atMs, engagedVehicles });
  const chain = decision.chain;

  return {
    ok: decision.conflicts.length === 0,
    mode: "drill",
    at,
    post: { id: post.id, label: post.label, activity_id: post.activity_id, region: post.region, ref: post.ref, risk: post.risk },
    scenario: { injury, heat: decision.heat, norm_id: decision.norm_id },
    responder: {
      team: {
        id: decision.team_id,
        label: resLabel(state, decision.team_id),
        source_post_id: decision.team_source_post_id,
        preempted: decision.team_preempted,
        eta_min: decision.team_eta_min ?? 0,
      },
      aed: {
        id: decision.aed_id,
        label: resLabel(state, decision.aed_id),
        source_post_id: decision.aed_source_post_id,
        preempted: decision.aed_preempted,
        eta_min: decision.aed_eta_min ?? null,
      },
    },
    handoff: chain
      ? {
          vehicle: { id: chain.vehicle_id, label: resLabel(state, chain.vehicle_id) },
          route: { id: chain.route_id, label: resLabel(state, chain.route_id) },
          facility: {
            id: chain.facility_id,
            label: resLabel(state, chain.facility_id),
            reception_window: facWindow(state, chain.facility_id),
          },
          eta_min: chain.eta_min,
          eta_limit_min: decision.chain_limit_min,
          alternative_chains: decision.chain_candidates - 1,
        }
      : null,
    preempts: decision.preempts.map((p) => ({
      kind: p.kind,
      resource: { id: p.resource_id, label: resLabel(state, p.resource_id) },
      donor_post_id: p.donor_post_id,
      eta_min: p.eta_min,
      backfilled: !!p.replacement,
      backfill: p.replacement
        ? { team_id: p.replacement.team_id, aed_id: p.replacement.aed_id }
        : null,
      conflicts: p.conflicts,
    })),
    conflicts: decision.conflicts.map((c) => ({ ...c, explanation: explain(c.code) })),
    // 注意：推演不落事件；真实演练可随后调用 report_incident 获得相同决策并留痕。
  };
}

// ---- 管理端：冲突与每次调整的完整解释 ----
export function adminView(engine, { asOf = Date.now() } = {}) {
  const s = engine.snapshotAt(asOf);
  const posts = s.allPosts.map((p) => {
    const asg = s.assignments.get(p.id);
    return {
      post_id: p.id,
      label: p.label,
      activity_id: p.activity_id,
      risk: p.risk,
      window: p.window,
      cover_window: { start: iso(p.coverWindow.start), end: iso(p.coverWindow.end) },
      team_id: asg?.team_id ?? null,
      aed_id: asg?.aed_id ?? null,
      aed_response_min: asg?.aed_response_min ?? null,
      chain: asg?.chain ?? null,
      heat: asg?.heat ?? false,
      covered: !!asg,
    };
  });

  const adjustments = s.adjustments.map((a) => ({
    at: iso(a.at),
    event_id: a.event_id,
    reason: a.reason,
    notice_id: a.notice_id ?? null,
    incident_id: a.incident_id ?? null,
    plan_id: a.plan_id ?? null,
    affected_post_ids: a.affected_post_ids ?? [],
    changes: (a.affected_post_ids ?? []).map((id) => ({
      post_id: id,
      before: a.before?.[id] ? summarizeAssignment(a.before[id]) : null,
      after: a.after?.[id] ? summarizeAssignment(a.after[id]) : null,
    })),
    preempt: a.preempt ?? null,
    conflicts: (a.conflicts ?? []).map((c) => ({ ...c, explanation: explain(c.code) })),
  }));

  const escalations = s.escalations.map((e) => ({
    at: iso(e.at),
    event_id: e.event_id ?? null,
    incident_id: e.incident_id,
    post_id: e.post_id,
    escalation: e.escalation,
    detail: e.detail ?? null,
    conflicts: (e.conflicts ?? []).map((c) => ({ ...c, explanation: explain(c.code) })),
  }));

  return {
    mode: "admin",
    as_of: iso(asOf),
    plans: [...s.plans.values()].map((e) => ({
      plan_id: e.plan.plan_id,
      status: e.status,
      norm_id: e.plan.norm_id,
      signer: e.decision?.signer ?? null,
      submitted_by: e.plan.submitted_by ?? null,
      conflicts: (e.decision?.conflicts ?? []).map((c) => ({ ...c, explanation: explain(c.code) })),
    })),
    posts,
    heat_scopes: s.heatScopes.map((h) => ({ scope: h.scope, window: [iso(h.window[0]), iso(h.window[1])] })),
    engagements: [...s.incidents.values()]
      .filter((i) => i.engagement)
      .map((i) => ({
        incident_id: i.incident_id,
        post_id: i.opened.post_id,
        injury: i.opened.injury,
        vehicle_id: i.engagement.vehicle_id,
        resources: i.engagement.resources,
        until: iso(i.engagement.window[1]),
      })),
    adjustments,
    escalations,
    open_incidents: [...s.incidents.values()].map((i) => ({
      incident_id: i.incident_id,
      post_id: i.opened.post_id,
      injury: i.opened.injury,
      handoff: i.handoff
        ? { facility_id: i.handoff.facility_id, arrived_at: i.handoff.arrived_at, phi_ref: i.handoff.phi_ref }
        : null,
    })),
  };
}

function summarizeAssignment(a) {
  return {
    team_id: a.team_id ?? null,
    aed_id: a.aed_id ?? null,
    aed_response_min: a.aed_response_min ?? null,
    route_id: a.chain?.route_id ?? null,
    vehicle_id: a.chain?.vehicle_id ?? null,
    facility_id: a.chain?.facility_id ?? null,
  };
}

// ---- 公开赛事视图：给参赛者/观众看。绝不读取 PHI，不含人员证照等内部信息 ----
export function publicView(engine, { asOf = Date.now() } = {}) {
  const s = engine.snapshotAt(asOf);
  return {
    mode: "public",
    as_of: iso(asOf),
    phi_included: false,
    activities: [...s.plans.values()]
      .filter((e) => e.status === "approved")
      .flatMap((e) =>
        (e.plan.activities ?? []).map((a) => ({
          id: a.id,
          type: a.type,
          label: a.label,
          window: a.window,
          audience: a.audience,
          heat_advisory: s.heatScopes.some(
            (h) =>
              (h.scope.activity_ids?.includes(a.id) || (h.scope.region && a.region === h.scope.region)) &&
              h.window[0] <= asOf && asOf < h.window[1],
          ),
        })),
      ),
    posts: s.allPosts
      .map((p) => ({
        id: p.id,
        activity_id: p.activity_id,
        label: p.label,
        kind: p.kind,
        region: p.region,
        window: p.window,
        medical_present: !!s.assignments.get(p.id),
        aed_on_site: !!s.assignments.get(p.id)?.aed_id,
        // 只暴露服务状态，不暴露队伍人员、证照、车辆编号等内部调度信息
        nearest_reception: (() => {
          const facId = s.assignments.get(p.id)?.chain?.facility_id;
          return facId ? { label: resLabel(s, facId) } : null;
        })(),
      })),
  };
}
