// 资源调度引擎：把"某时刻某点位由谁接手"从事先争抢变成确定性预指派。
// 纯函数：输入四方维护的资料快照 + 时刻覆盖层，输出逐时间槽的指派表、冲突与冗余警告。
//
// overrides 覆盖层（编排核心使用）：
//   heat: [{position_ids, window}]                 高温预警，命中的岗位风险升一级
//   device_blacklist: [device_id]                  故障设备
//   team_blacklist: [team_id]                      证照到期/停用队伍
//   corridor_overrides: [{corridor_id, status}]    路线改变
//   position_windows: [{position_id, window}]      点位时段改变
//   risk_overrides: [{at, position_id, risk}]      突发事件把某槽位风险强制为指定等级
//   extra_positions: [position]                    突发事发现场（临时点位，corridor_via 借用相邻点位通道）
//   extra_corridors: [corridor]                    突发事件现场临时开辟的转运通道
//   pins: [assignment]                             锁定：本次重排不得改动的既存指派

import {
  activeRegulationAt,
  deviceReady,
  etaMinutes,
  km,
  overlap,
  RISK_LEVELS,
  teamQualifies,
  t,
} from "./domain.js";

export const SLOT_MINUTES = 10;
const TEAM_SPEED_KMH = 30;

export const CONFLICT_CODES = Object.freeze({
  NO_REGULATION: "NO_REGULATION",
  NO_TEAM: "NO_TEAM_QUALIFIED",
  TEAM_BUSY: "TEAM_BUSY",
  TEAM_TOO_FAR: "TEAM_TOO_FAR",
  NO_AED: "NO_AED_READY",
  AED_TOO_FAR: "AED_TOO_FAR",
  NO_VEHICLE: "NO_VEHICLE_AVAILABLE",
  NO_CORRIDOR: "NO_OPEN_CORRIDOR",
  NO_HOSPITAL: "NO_CAPABLE_HOSPITAL",
  HOSPITAL_CLOSED: "HOSPITAL_WINDOW_CLOSED",
});

export function slotFloor(ms) {
  return Math.floor(ms / (SLOT_MINUTES * 60000)) * SLOT_MINUTES * 60000;
}

export function buildSchedule(snapshot, overrides = {}) {
  const { events, teams, devices, vehicles, hospitals, corridors, regulations } = snapshot;
  const positions = events
    .flatMap((e) => (e.positions ?? []).map((p) => ({ ...p, event_id: e.event_id, group: e.group })))
    .concat(overrides.extra_positions ?? []);

  const horizon = eventHorizon(positions);
  const slots = enumerateSlots(horizon.start, horizon.end);

  const heatActive = heatIndex(overrides.heat ?? []);
  const deviceBlocked = new Set(overrides.device_blacklist ?? []);
  const teamBlocked = new Set(overrides.team_blacklist ?? []);
  const corridorStatus = corridorIndex(corridors, overrides.corridor_overrides ?? [], overrides.extra_corridors ?? []);
  const positionWindows = new Map((overrides.position_windows ?? []).map((o) => [o.position_id, o.window]));
  const riskForced = riskIndex(overrides.risk_overrides ?? []);
  const pinsBySlot = pinIndex(overrides.pins ?? []);

  const bySlot = new Map();

  for (const slot of slots) {
    const busyTeams = new Set();
    const busyVehicles = new Set();
    const busyAeds = new Set();
    const assignments = [];
    const conflicts = [];
    const warnings = [];

    const pinned = new Set((pinsBySlot.get(slot) ?? []).map((p) => p.position_id));

    // 锁定的指派先占资源，且不参与本轮重新选择。
    for (const pin of pinsBySlot.get(slot) ?? []) {
      assignments.push(pin);
      if (pin.team_id) busyTeams.add(pin.team_id);
      if (pin.aed_id) busyAeds.add(pin.aed_id);
      if (pin.vehicle_id) busyVehicles.add(pin.vehicle_id);
    }

    const live = positions
      .map((p) => {
        const win = positionWindows.get(p.position_id) ?? p.window;
        return {
          pos: p,
          win,
          risk: riskForced.get(`${slot}|${p.position_id}`) ?? effectiveRisk(p, slot, heatActive),
          active: win && overlap(slot, slot + SLOT_MINUTES * 60000, t(win.start), t(win.end)),
        };
      })
      .filter((x) => x.active && !pinned.has(x.pos.position_id))
      // 高风险点位优先挑资源，保证同一份输入下结果可复现
      .sort((a, b) => RISK_LEVELS.indexOf(b.risk) - RISK_LEVELS.indexOf(a.risk) || a.pos.position_id.localeCompare(b.pos.position_id));

    for (const { pos, risk } of live) {
      const reg = activeRegulationAt(regulations, slot);
      if (!reg) {
        conflicts.push(conflict(pos, CONFLICT_CODES.NO_REGULATION, "该时刻没有生效中的安全规范版本"));
        continue;
      }
      const needQual = reg.rules.min_qual_by_risk[risk] ?? "first_aid";

      // —— 救护队（主责 + 备援） ——
      const teamCandidates = teams
        .filter((tm) => !teamBlocked.has(tm.team_id))
        .filter((tm) => teamQualifies(tm, needQual, slot))
        .map((tm) => ({ tm, eta: etaMinutes(tm.at, pos.at, tm.speed_kmh ?? TEAM_SPEED_KMH) }))
        .filter((c) => c.eta <= reg.rules.response_minutes[risk])
        .sort((a, b) => a.eta - b.eta || a.tm.team_id.localeCompare(b.tm.team_id));

      const primary = teamCandidates.find((c) => !busyTeams.has(c.tm.team_id));
      if (!primary) {
        const anyQual = teams.filter((tm) => !teamBlocked.has(tm.team_id) && teamQualifies(tm, needQual, slot));
        const code =
          anyQual.length === 0
            ? CONFLICT_CODES.NO_TEAM
            : anyQual.every((tm) => etaMinutes(tm.at, pos.at, tm.speed_kmh ?? TEAM_SPEED_KMH) > reg.rules.response_minutes[risk])
              ? CONFLICT_CODES.TEAM_TOO_FAR
              : CONFLICT_CODES.TEAM_BUSY;
        conflicts.push(conflict(pos, code, `风险=${risk}，要求资质≥${needQual}、${reg.rules.response_minutes[risk]}分钟内到达`));
      } else {
        busyTeams.add(primary.tm.team_id);
      }
      const backup = teamCandidates.find((c) => c !== primary && !busyTeams.has(c.tm.team_id));
      if (primary && !backup) {
        warnings.push(conflict(pos, "BACKUP_TEAM_MISSING", `${reg.rules.response_minutes[risk]}分钟内没有第二支空闲合格队伍作备援`));
      }

      // —— AED ——
      const aedCandidates = devices
        .filter((d) => !deviceBlocked.has(d.device_id) && deviceReady(d, slot))
        .map((d) => ({ d, dist: Math.round(km(d.at, pos.at) * 1000) }))
        .filter((c) => c.dist <= reg.rules.aed_within_m[risk])
        .sort((a, b) => a.dist - b.dist || a.d.device_id.localeCompare(b.d.device_id));
      const aed = aedCandidates.find((c) => !busyAeds.has(c.d.device_id));
      if (!aed) {
        const ready = devices.filter((d) => !deviceBlocked.has(d.device_id) && deviceReady(d, slot));
        conflicts.push(
          conflict(pos, ready.length === 0 ? CONFLICT_CODES.NO_AED : CONFLICT_CODES.AED_TOO_FAR, `风险=${risk}，要求 ${reg.rules.aed_within_m[risk]} 米内有就绪 AED`)
        );
      } else {
        busyAeds.add(aed.d.device_id);
      }

      // —— 接收医院 + 转运通道联合选择 ——
      // 通道通往的医院必须具备该人群所需能力；首选通道关闭时，自动改走通往另一家合格医院的备用通道。
      const requiredCaps = snapshot.capability_matrix?.[pos.group] ?? [];
      const capableHospitals = hospitals
        .filter((h) => requiredCaps.every((c) => h.capabilities.includes(c)))
        .filter((h) => windowOpen(h.emergency_window, slot));
      const route = capableHospitals
        .flatMap((h) => openCorridors(corridorStatus, pos, slot, h.hospital_id).map((c) => ({ hospital: h, corridor: c })))
        .sort(
          (a, b) =>
            a.corridor.minutes - b.corridor.minutes ||
            a.hospital.hospital_id.localeCompare(b.hospital.hospital_id) ||
            a.corridor.corridor_id.localeCompare(b.corridor.corridor_id)
        )[0];
      const hospital = route?.hospital ?? capableHospitals[0] ?? null;
      const corridor = route?.corridor ?? null;
      if (capableHospitals.length === 0) {
        conflicts.push(conflict(pos, CONFLICT_CODES.NO_HOSPITAL, `人群=${pos.group}，需要能力 ${requiredCaps.join("+")} 且急诊窗口开放`));
      } else if (!corridor) {
        conflicts.push(conflict(pos, CONFLICT_CODES.NO_CORRIDOR, `合格医院（如 ${hospital.name}）在该时刻无开放通道`));
      }

      // —— 救护车/接驳车（是否预置由规范按风险等级规定） ——
      let vehicle = null;
      const needVehicle = reg.rules.transport_required?.[risk] !== false;
      if (corridor && hospital && needVehicle) {
        const vc = vehicles
          .filter((v) => v.status === "ready")
          .map((v) => ({ v, reach: etaMinutes(v.at, pos.at, v.speed_kmh) }))
          .filter((c) => c.reach + corridor.minutes <= reg.rules.transport_minutes[risk])
          .sort((a, b) => a.reach - b.reach || a.v.vehicle_id.localeCompare(b.v.vehicle_id))
          .find((c) => !busyVehicles.has(c.v.vehicle_id));
        if (!vc) {
          conflicts.push(conflict(pos, CONFLICT_CODES.NO_VEHICLE, `风险=${risk}，要求 ${reg.rules.transport_minutes[risk]} 分钟内完成转运交接`));
        } else {
          vehicle = vc;
          busyVehicles.add(vc.v.vehicle_id);
        }
      }

      assignments.push({
        slot,
        position_id: pos.position_id,
        position_name: pos.name,
        event_id: pos.event_id,
        group: pos.group,
        risk,
        ephemeral: pos.ephemeral ?? false,
        team_id: primary?.tm.team_id ?? null,
        team_eta_min: primary?.eta ?? null,
        backup_team_id: backup?.tm.team_id ?? null,
        aed_id: aed?.d.device_id ?? null,
        aed_distance_m: aed?.dist ?? null,
        vehicle_id: vehicle?.v.vehicle_id ?? null,
        corridor_id: corridor?.corridor_id ?? null,
        hospital_id: hospital?.hospital_id ?? null,
        handoff_eta_min: vehicle ? vehicle.reach + corridor.minutes : corridor ? corridor.minutes : null,
        handoff_capabilities: requiredCaps,
        regulation_version: reg.version,
      });
    }

    bySlot.set(slot, { assignments, conflicts, warnings });
  }

  return { slot_minutes: SLOT_MINUTES, bySlot };
}

// 演练人员的核心问题：指定时刻、指定点位，谁立即接手、交给谁。
export function responseAt(schedule, atIso, positionId) {
  const at = typeof atIso === "number" ? atIso : t(atIso);
  const slot = slotFloor(at);
  const frame = schedule.bySlot.get(slot);
  if (!frame) return null;
  return {
    slot,
    assignment: frame.assignments.find((a) => a.position_id === positionId) ?? null,
    conflicts: frame.conflicts.filter((c) => c.position_id === positionId),
    warnings: frame.warnings.filter((c) => c.position_id === positionId),
  };
}

export function isConflictFree(schedule) {
  for (const frame of schedule.bySlot.values()) {
    if (frame.conflicts.length > 0) return false;
  }
  return true;
}

export function flattenAssignments(schedule) {
  const out = [];
  for (const frame of schedule.bySlot.values()) out.push(...frame.assignments);
  return out;
}

// ---------- 内部工具 ----------

function conflict(pos, code, detail) {
  return { position_id: pos.position_id, position_name: pos.name, event_id: pos.event_id, code, detail };
}

function effectiveRisk(pos, slot, heatIndexMap) {
  const heat = heatIndexMap.get(pos.position_id);
  if (!heat || !heat.has(slot)) return pos.risk;
  return RISK_LEVELS[Math.min(RISK_LEVELS.indexOf(pos.risk) + 1, RISK_LEVELS.length - 1)];
}

function heatIndex(heatWaves) {
  const map = new Map();
  for (const h of heatWaves) {
    for (let s = slotFloor(t(h.window.start)); s < t(h.window.end); s += SLOT_MINUTES * 60000) {
      for (const id of h.position_ids ?? []) {
        if (!map.has(id)) map.set(id, new Set());
        map.get(id).add(s);
      }
    }
  }
  return map;
}

function corridorIndex(corridors, overrides, extras = []) {
  const map = new Map(corridors.map((c) => [c.corridor_id, { ...c }]));
  for (const c of extras) if (!map.has(c.corridor_id)) map.set(c.corridor_id, { ...c, ephemeral: true });
  for (const o of overrides) {
    const cur = map.get(o.corridor_id);
    if (cur) Object.assign(cur, o);
  }
  return map;
}

function riskIndex(overrides) {
  const map = new Map();
  for (const o of overrides) map.set(`${slotFloor(t(o.at))}|${o.position_id}`, o.risk);
  return map;
}

function pinIndex(pins) {
  const map = new Map();
  for (const p of pins) {
    if (!map.has(p.slot)) map.set(p.slot, []);
    map.get(p.slot).push(p);
  }
  return map;
}

function openCorridors(index, pos, slot, hospitalId) {
  const ids = [pos.position_id, pos.corridor_via].filter(Boolean);
  const out = [];
  for (const c of index.values()) {
    if (c.status !== "open") continue;
    if (!c.serves_positions?.some((id) => ids.includes(id))) continue;
    if (hospitalId && c.to_hospital_id !== hospitalId) continue;
    if (c.window && !windowOpen(c.window, slot)) continue;
    out.push(c);
  }
  return out;
}

function windowOpen(win, slot) {
  if (!win) return true;
  return overlap(slot, slot + SLOT_MINUTES * 60000, t(win.start), t(win.end));
}

function eventHorizon(positions) {
  let start = Infinity;
  let end = -Infinity;
  for (const p of positions) {
    start = Math.min(start, t(p.window.start));
    end = Math.max(end, t(p.window.end));
  }
  return { start, end };
}

function enumerateSlots(start, end) {
  const out = [];
  for (let s = slotFloor(start); s < end; s += SLOT_MINUTES * 60000) out.push(s);
  return out;
}
