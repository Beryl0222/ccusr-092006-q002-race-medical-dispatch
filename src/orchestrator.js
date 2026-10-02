// 编排核心：签署生效、按时刻响应查询、局部重排、突发抢占与补位升级、通知幂等、审计解释、健康资料隔离。
// 全部状态保存在内存中（可序列化为 JSON），不依赖任何外部服务，可独立运行。

import { createHash } from "node:crypto";
import { publicView, t } from "./domain.js";
import { buildSchedule, flattenAssignments, responseAt as querySchedule, SLOT_MINUTES, slotFloor } from "./scheduler.js";

const SLOT_MS = SLOT_MINUTES * 60000;
const RESOURCE_FIELDS = ["team_id", "backup_team_id", "aed_id", "vehicle_id", "corridor_id", "hospital_id"];

export class PlanNotEffectiveError extends Error {
  constructor(message) {
    super(message);
    this.code = "PLAN_NOT_EFFECTIVE";
  }
}

export class Orchestrator {
  constructor({ snapshot, healthVault = null, signers = [], clock = () => new Date().toISOString() }) {
    this.snapshot = snapshot;
    this.healthVault = healthVault;
    this.signers = signers;
    this.clock = clock;

    this.plan = null; // 已签署生效的预案
    this.overrides = emptyOverrides();
    this.audit = []; // 每次签署/调整/抢占的完整记录
    this.tasks = new Map(); // fingerprint -> 任务（通知幂等）
    this.seq = 0;
  }

  // ---------- 预案签署：只有无冲突、适用当时规范、且有权人员签署才生效 ----------

  approvePlan({ at, signer_id, overrides = {}, plan_id }) {
    const signer = this.signers.find((s) => s.signer_id === signer_id);
    if (!signer || !signer.authorities.includes("medical_plan") || !signerActive(signer, at)) {
      throw Object.assign(new Error("签署人无权在该时刻签署医疗保障方案"), { code: "SIGNER_UNAUTHORIZED" });
    }
    const ov = mergeOverrides(emptyOverrides(), overrides);
    const schedule = buildSchedule(this.snapshot, ov);
    const conflicts = collectConflicts(schedule);
    if (conflicts.length > 0) {
      const err = new Error("方案存在资源冲突，不能签署生效");
      err.code = "PLAN_HAS_CONFLICTS";
      err.conflicts = conflicts;
      throw err;
    }

    const id = plan_id ?? `plan-${pad(++this.seq)}`;
    const manifest = this.manifest(ov);
    this.plan = {
      plan_id: id,
      signed_at: at,
      signer: { signer_id: signer.signer_id, name: signer.name, title: signer.title },
      signature: sha256(canonical(manifest)),
      manifest,
      schedule,
    };
    this.overrides = ov;
    this.audit.push({ id, at: this.clock(), type: "PLAN_APPROVED", reason: "预案签署生效", signer_id, conflicts: [], diffs: [], impacted: [] });
    return { plan_id: id, signature: this.plan.signature, tasks_notified: this.syncTasks(id, schedule, at) };
  }

  // 管理端：当前方案的资源冲突（签署前预检也走这里）
  previewConflicts(overrides = {}) {
    return collectConflicts(buildSchedule(this.snapshot, mergeOverrides(cloneOverrides(this.overrides), overrides)));
  }

  // ---------- 演练人员：指定时刻、指定点位，谁立即接手 ----------

  responseAt(at, positionId) {
    this.requireEffectivePlan();
    const hit = querySchedule(this.plan.schedule, at, positionId);
    if (!hit || !hit.assignment) return hit;
    return { ...hit, assignment: this.enrich(hit.assignment), plan_id: this.plan.plan_id };
  }

  // 同一时刻多个点位同时呼救：一次性给出全部接手方（路跑/青少年球赛/老年健步并发伤情）
  responseAtMany(at, positionIds) {
    this.requireEffectivePlan();
    return positionIds.map((pid) => this.responseAt(at, pid));
  }

  // ---------- 四类局部重排：高温/证照/设备/路线/时段，只动受影响岗位 ----------

  applyHeatWarning({ at, operator, window, position_ids, severity = "orange" }) {
    return this.replan({
      at,
      operator,
      reason: `高温${severity}预警：${position_ids.join("、")} 风险升级`,
      reason_code: "HEAT_WARNING",
      patch: { heat: [...this.overrides.heat, { position_ids, window }] },
      impactKeys: (sched) => keysFor(sched, (a) => position_ids.includes(a.position_id) && withinWindow(a.slot, window)),
    });
  }

  reportDeviceFailure({ at, operator, device_id }) {
    return this.replan({
      at,
      operator,
      reason: `设备 ${device_id} 故障停用，重排使用该设备的岗位`,
      reason_code: "DEVICE_FAILURE",
      patch: { device_blacklist: unique([...this.overrides.device_blacklist, device_id]) },
      impactKeys: (sched) => keysFor(sched, (a) => a.aed_id === device_id),
    });
  }

  reportCredentialExpiry({ at, operator, team_id }) {
    return this.replan({
      at,
      operator,
      reason: `队伍 ${team_id} 证照到期停用，重排使用该队伍的岗位`,
      reason_code: "CREDENTIAL_EXPIRY",
      patch: { team_blacklist: unique([...this.overrides.team_blacklist, team_id]) },
      impactKeys: (sched) => keysFor(sched, (a) => a.team_id === team_id || a.backup_team_id === team_id),
    });
  }

  rerouteCorridor({ at, operator, corridor_id, status }) {
    return this.replan({
      at,
      operator,
      reason: `转运通道 ${corridor_id} 状态变更为 ${status}`,
      reason_code: "CORRIDOR_REROUTE",
      patch: { corridor_overrides: upsert(this.overrides.corridor_overrides, "corridor_id", { corridor_id, status }) },
      impactKeys: (sched, snap) => {
        const served = new Set((snap.corridors.find((c) => c.corridor_id === corridor_id)?.serves_positions ?? []));
        return keysFor(sched, (a) => served.has(a.position_id) || a.corridor_id === corridor_id);
      },
    });
  }

  changePositionWindow({ at, operator, position_id, window }) {
    const oldWindows = new Map();
    for (const e of this.snapshot.events) for (const p of e.positions ?? []) oldWindows.set(p.position_id, p.window);
    const oldWin = oldWindows.get(position_id);
    return this.replan({
      at,
      operator,
      reason: `点位 ${position_id} 时段调整`,
      reason_code: "POSITION_WINDOW_CHANGE",
      patch: { position_windows: upsert(this.overrides.position_windows, "position_id", { position_id, window }) },
      impactKeys: (sched) =>
        keysFor(sched, (a) => a.position_id === position_id && (withinWindow(a.slot, window) || (oldWin && withinWindow(a.slot, oldWin)))),
    });
  }

  // ---------- 突发事件：可抢占低风险点位，原任务同步获得补位与升级记录 ----------

  declareIncident({ at, operator, position_id = null, ephemeral = null, window_minutes = 30, corridor_overrides = [] }) {
    this.requireEffectivePlan();
    const start = slotFloor(t(at));
    const end = start + window_minutes * 60000;
    const patch = mergeOverrides(cloneOverrides(this.overrides), { corridor_overrides });

    let targetId;
    if (ephemeral) {
      const pos = {
        ...ephemeral,
        event_id: ephemeral.event_id ?? "INCIDENT",
        group: ephemeral.group,
        position_id: ephemeral.position_id ?? `incident-${pad(++this.seq)}`,
        ephemeral: true,
        risk: "high",
        window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      };
      targetId = pos.position_id;
      patch.extra_positions = [...patch.extra_positions, pos];
      if (ephemeral.corridor_id) {
        patch.extra_corridors = [
          ...(patch.extra_corridors ?? []),
          {
            corridor_id: ephemeral.corridor_id,
            name: ephemeral.corridor_name ?? `突发事件 ${targetId} 临时通道`,
            status: "open",
            serves_positions: [targetId, ...(ephemeral.corridor_serves ?? [])],
            to_hospital_id: ephemeral.to_hospital_id,
            minutes: ephemeral.corridor_minutes ?? 10,
          },
        ];
      }
    } else {
      targetId = position_id;
      patch.risk_overrides = [
        ...patch.risk_overrides,
        ...slotRange(start, end).map((s) => ({ at: new Date(s).toISOString(), position_id, risk: "high" })),
      ];
    }

    // 突发事件按高风险处理：事件窗内，同为高风险的岗位锁定不被抢；
    // 中/低风险岗位（相对突发事件的"低风险点位"）解锁，允许资源被抢占，窗外岗位一律锁定。
    const incidentSlots = new Set(slotRange(start, end));
    const oldFlat = flattenAssignments(this.plan.schedule);
    const pins = oldFlat.filter(
      (a) => !incidentSlots.has(a.slot) || (a.risk === "high" && a.position_id !== targetId)
    );
    const newSchedule = buildSchedule(this.snapshot, { ...patch, pins });

    const old = indexAssignments(this.plan.schedule);
    const impactedSlots = slotRange(start, end);
    const diffs = [];
    const backfills = [];
    const escalations = [];

    for (const frame of newSchedule.bySlot.values()) {
      if (!incidentSlots.has(frame.slot)) continue;
      for (const conflict of frame.conflicts) {
        if (conflict.position_id === targetId) escalations.push(missingEscalation(at, conflict, targetId));
      }
    }

    for (const a of flattenAssignments(newSchedule)) {
      if (!incidentSlots.has(a.slot)) continue;
      const key = `${a.slot}|${a.position_id}`;
      const before = old.get(key);
      if (a.position_id === targetId) {
        if (before) diffs.push(...diffAssignments(before, a));
        continue;
      }
      if (!before) continue;
      const stolen = RESOURCE_FIELDS.filter((f) => before[f] && before[f] !== a[f]);
      if (stolen.length === 0) continue;
      diffs.push(...diffAssignments(before, a));
      // 原任务：无论是否补到位，都同步生成补位记录与升级记录。
      const underfilled = missingResources(a);
      backfills.push({
        at,
        slot: a.slot,
        position_id: a.position_id,
        displaced_from: resourceSummary(before),
        reassigned_to: resourceSummary(a),
        stolen_fields: stolen,
        status: underfilled.length ? "open" : "backfilled",
      });
      escalations.push({
        at,
        slot: a.slot,
        position_id: a.position_id,
        kind: "LOW_RISK_PREEMPTED",
        detail: `突发事件 ${targetId} 抢占了该低风险点位资源（${stolen.join("、")}）`,
        missing: underfilled,
        status: underfilled.length ? "open" : "backfilled",
        notified: unique(["medical_director", ...(underfilled.length ? ["mutual_aid_coordinator"] : [])]),
      });
    }

    const id = `adj-${pad(++this.seq)}`;
    const conflicts = collectConflicts(newSchedule, incidentSlots);
    const taskKeys = new Set([
      ...diffs.map((d) => `${d.slot}|${d.position_id}`),
      ...slotRange(start, end).map((s) => `${s}|${targetId}`),
    ]);
    this.commitSchedule(id, at, operator, "INCIDENT_DECLARED", `突发事件：${targetId}`, patch, newSchedule, diffs, conflicts, {
      backfills,
      escalations,
      target_position: targetId,
    }, taskKeys);
    return this.adjustmentResult(id, { backfills, escalations });
  }

  // ---------- 通用重排 ----------

  replan({ at, operator, reason, reason_code, patch: rawPatch, impactKeys }) {
    this.requireEffectivePlan();
    const trial = mergeOverrides(cloneOverrides(this.overrides), rawPatch);
    // 先用既存指派锁定所有岗位，仅解锁受影响岗位，保证"只重排受影响的岗位"。
    // 受影响集合取旧调度（谁在用被撤资源）与试排（谁换了资源）的并集；
    // 锁定岗位占住资源，解锁岗位不可能偷走它们，连锁变化被限制在解锁集合内。
    const probe = buildSchedule(this.snapshot, trial);
    const unlocked = new Set([...impactKeys(this.plan.schedule, this.snapshot), ...impactKeys(probe, this.snapshot)]);
    const pins = flattenAssignments(this.plan.schedule).filter((a) => !unlocked.has(`${a.slot}|${a.position_id}`));
    const newSchedule = buildSchedule(this.snapshot, { ...trial, pins });

    const old = indexAssignments(this.plan.schedule);
    const diffs = [];
    for (const a of flattenAssignments(newSchedule)) {
      if (!unlocked.has(`${a.slot}|${a.position_id}`)) continue;
      const before = old.get(`${a.slot}|${a.position_id}`);
      if (before) diffs.push(...diffAssignments(before, a));
    }

    const id = `adj-${pad(++this.seq)}`;
    const conflicts = collectConflicts(newSchedule);
    const changedKeys = new Set(diffs.map((d) => `${d.slot}|${d.position_id}`));
    this.commitSchedule(id, at, operator, reason_code, reason, trial, newSchedule, diffs, conflicts, {}, changedKeys);
    return this.adjustmentResult(id, {});
  }

  commitSchedule(id, at, operator, reasonCode, reason, overrides, schedule, diffs, conflicts, extra, taskKeys = null) {
    this.overrides = overrides;
    this.plan = { ...this.plan, schedule, superseded_at: at };
    const record = {
      id,
      at: this.clock(),
      effective_at: at,
      type: reasonCode,
      reason,
      operator: operator ?? null,
      impacted: unique(diffs.map((d) => d.position_id)),
      diffs,
      conflicts,
      ...extra,
    };
    this.audit.push(record);
    this.syncTasks(id, schedule, at, taskKeys);
    return record;
  }

  // ---------- 通知幂等：同一事项重复通知只生成一份任务 ----------

  notify(notification) {
    const fingerprint = notification.fingerprint;
    const existing = this.tasks.get(fingerprint);
    if (existing) return { created: false, task: existing, fingerprint };
    const task = {
      fingerprint,
      created_at: this.clock(),
      adjustment_id: notification.adjustment_id,
      slot: notification.slot,
      position_id: notification.position_id,
      role: notification.role,
      instruct: notification.instruct,
      status: "active",
    };
    this.tasks.set(fingerprint, task);
    return { created: true, task, fingerprint };
  }

  // 依据调整后的指派差异生成/同步任务；重复调用同一调整不会产生第二份，
  // 且未变动的岗位不会收到新任务。
  syncTasks(adjustmentId, schedule, at, onlyKeys = null) {
    let created = 0;
    for (const a of flattenAssignments(schedule)) {
      if (onlyKeys && !onlyKeys.has(`${a.slot}|${a.position_id}`)) continue;
      for (const role of ["team", "aed", "vehicle"]) {
        const resourceId = role === "team" ? a.team_id : role === "aed" ? a.aed_id : a.vehicle_id;
        if (!resourceId) continue;
        const fp = `${adjustmentId}:${a.slot}:${a.position_id}:${role}`;
        const r = this.notify({
          fingerprint: fp,
          adjustment_id: adjustmentId,
          slot: a.slot,
          position_id: a.position_id,
          role,
          instruct: `${a.position_name} 于 ${new Date(a.slot).toISOString()} 由 ${role}/${resourceId} 接手`,
        });
        if (r.created) created++;
      }
    }
    return { created, total: this.tasks.size };
  }

  listTasks() {
    return [...this.tasks.values()];
  }

  // ---------- 管理端解释 ----------

  explainConflicts(at = null) {
    this.requireEffectivePlan();
    let conflicts = collectConflicts(this.plan.schedule);
    if (at) {
      const s = slotFloor(t(at));
      const frame = this.plan.schedule.bySlot.get(s);
      conflicts = frame ? frame.conflicts : [];
    }
    return conflicts.map((c) => ({ ...c, resource_pool: this.explainPool(c, at) }));
  }

  explainPool(conflict, at) {
    // 说明"为什么没人能接"：把全部候选资源的状态摊开给管理端
    const pos = allPositions(this.snapshot).find((p) => p.position_id === conflict.position_id);
    if (!pos) return null;
    return {
      teams: this.snapshot.teams.map((tm) => ({ team_id: tm.team_id, qual_level: tm.qual_level, maintained_by: tm.maintained_by })),
      devices: this.snapshot.devices.map((d) => ({ device_id: d.device_id, status: d.status, maintained_by: d.maintained_by })),
      vehicles: this.snapshot.vehicles.map((v) => ({ vehicle_id: v.vehicle_id, status: v.status, maintained_by: v.maintained_by })),
      corridors: this.snapshot.corridors.map((c) => ({ corridor_id: c.corridor_id, status: c.status, serves_positions: c.serves_positions })),
    };
  }

  explainAdjustment(adjustmentId) {
    const record = this.audit.find((r) => r.id === adjustmentId);
    if (!record) throw Object.assign(new Error("调整记录不存在"), { code: "NOT_FOUND" });
    return record;
  }

  auditLog() {
    return this.audit;
  }

  // ---------- 健康资料隔离 ----------

  // 公开赛事视图：任何对外输出都过脱敏，不含真实个人健康资料。
  publicState() {
    return publicView({
      plan_id: this.plan?.plan_id ?? null,
      signed_by: this.plan?.signer ?? null,
      schedule: this.plan
        ? flattenAssignments(this.plan.schedule).map((a) => ({
            ...this.enrich(a),
            slot: new Date(a.slot).toISOString(),
          }))
        : [],
      tasks: [...this.tasks.values()],
    });
  }

  // 受限健康库：只有赛事医疗官 + phi 授权可读，且每次读取留痕。
  readHealthRecords({ role, scopes }) {
    if (!this.healthVault) throw Object.assign(new Error("未挂载健康库"), { code: "NO_HEALTH_VAULT" });
    return this.healthVault.read(this.clock(), role, scopes);
  }

  // ---------- 持久化 ----------

  serialize() {
    return JSON.stringify({
      plan: this.plan && { ...this.plan, schedule: undefined },
      overrides: this.overrides,
      audit: this.audit,
      tasks: [...this.tasks.entries()],
      seq: this.seq,
    });
  }

  // ---------- 内部 ----------

  requireEffectivePlan() {
    if (!this.plan) throw new PlanNotEffectiveError("尚无经有权人员签署且生效的保障方案");
  }

  enrich(a) {
    if (!a) return a;
    const name = (list, id, key) => list.find((x) => x[key] === id)?.name ?? null;
    return {
      ...a,
      team_name: name(this.snapshot.teams, a.team_id, "team_id"),
      backup_team_name: name(this.snapshot.teams, a.backup_team_id, "team_id"),
      aed_name: name(this.snapshot.devices, a.aed_id, "device_id"),
      vehicle_name: name(this.snapshot.vehicles, a.vehicle_id, "vehicle_id"),
      corridor_name: name(this.snapshot.corridors, a.corridor_id, "corridor_id"),
      hospital_name: name(this.snapshot.hospitals, a.hospital_id, "hospital_id"),
      slot_iso: new Date(a.slot).toISOString(),
    };
  }

  adjustmentResult(id, extra) {
    return { adjustment_id: id, record: this.audit.find((r) => r.id === id), ...extra };
  }

  manifest(overrides) {
    return {
      data_versions: this.snapshot.data_versions,
      regulation_versions: this.snapshot.regulations.map((r) => ({ version: r.version, effective_from: r.effective_from, effective_to: r.effective_to })),
      overrides,
    };
  }
}

// ---------- 工具函数 ----------

function emptyOverrides() {
  return {
    heat: [],
    device_blacklist: [],
    team_blacklist: [],
    corridor_overrides: [],
    position_windows: [],
    risk_overrides: [],
    extra_positions: [],
  };
}

function cloneOverrides(o) {
  return JSON.parse(JSON.stringify(o));
}

function mergeOverrides(base, patch) {
  const out = cloneOverrides(base);
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (Array.isArray(out[k]) && Array.isArray(v)) out[k] = out[k].concat(v);
    else out[k] = v;
  }
  return out;
}

function upsert(list, key, item) {
  const rest = list.filter((x) => x[key] !== item[key]);
  return [...rest, item];
}

const unique = (arr) => [...new Set(arr)];
const pad = (n) => String(n).padStart(3, "0");

function collectConflicts(schedule, onlySlots = null) {
  const out = [];
  for (const [slot, frame] of schedule.bySlot) {
    if (onlySlots && !onlySlots.has(slot)) continue;
    out.push(...frame.conflicts);
  }
  return out;
}

function indexAssignments(schedule) {
  const map = new Map();
  for (const a of flattenAssignments(schedule)) map.set(`${a.slot}|${a.position_id}`, a);
  return map;
}

function keysFor(schedule, pred) {
  const set = new Set();
  for (const a of flattenAssignments(schedule)) if (pred(a)) set.add(`${a.slot}|${a.position_id}`);
  return set;
}

function withinWindow(slot, window) {
  return slot < t(window.end) && slot + SLOT_MS > t(window.start);
}

function slotRange(start, end) {
  const out = [];
  for (let s = slotFloor(start); s < end; s += SLOT_MS) out.push(s);
  return out;
}

function diffAssignments(before, after) {
  const out = [];
  for (const f of RESOURCE_FIELDS) {
    if ((before[f] ?? null) !== (after[f] ?? null)) {
      out.push({ slot: after.slot, position_id: after.position_id, field: f, from: before[f] ?? null, to: after[f] ?? null });
    }
  }
  if (before.risk !== after.risk) out.push({ slot: after.slot, position_id: after.position_id, field: "risk", from: before.risk, to: after.risk });
  return out;
}

function missingResources(a) {
  const need = ["team_id", "aed_id", "corridor_id", "hospital_id"];
  if (a.risk !== "low") need.push("vehicle_id"); // 中/高风险规范要求预置车辆
  return need.filter((f) => !a[f]);
}

function resourceSummary(a) {
  return { team_id: a.team_id, aed_id: a.aed_id, vehicle_id: a.vehicle_id, corridor_id: a.corridor_id, hospital_id: a.hospital_id };
}

function missingEscalation(at, conflict, targetId) {
  const map = {
    NO_TEAM_QUALIFIED: "team_id",
    TEAM_BUSY: "team_id",
    TEAM_TOO_FAR: "team_id",
    NO_AED_READY: "aed_id",
    AED_TOO_FAR: "aed_id",
    NO_VEHICLE_AVAILABLE: "vehicle_id",
    NO_OPEN_CORRIDOR: "corridor_id",
    NO_CAPABLE_HOSPITAL: "hospital_id",
    HOSPITAL_WINDOW_CLOSED: "hospital_id",
  };
  return {
    at,
    position_id: targetId,
    kind: "INCIDENT_UNDER_RESOURCED",
    missing: [map[conflict.code] ?? conflict.code],
    conflict: conflict.code,
    detail: conflict.detail,
    status: "open",
    notified: ["medical_director", "mutual_aid_coordinator"],
  };
}

function allPositions(snapshot) {
  return snapshot.events.flatMap((e) => (e.positions ?? []).map((p) => ({ ...p, group: e.group })));
}

function signerActive(signer, atIso) {
  const at = t(atIso);
  return t(signer.authority_from) <= at && (!signer.authority_to || at < t(signer.authority_to));
}

function canonical(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  }
  return value;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
