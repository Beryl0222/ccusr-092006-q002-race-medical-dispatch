import assert from "node:assert/strict";
import test from "node:test";
import { buildSchedule, CONFLICT_CODES, isConflictFree, responseAt, SLOT_MINUTES } from "../src/scheduler.js";

const REGS = [
  {
    version: "R1",
    effective_from: "2026-01-01T00:00:00+08:00",
    effective_to: null,
    rules: {
      min_qual_by_risk: { low: "first_aid", medium: "first_aid_cert", high: "emt" },
      response_minutes: { low: 12, medium: 8, high: 5 },
      aed_within_m: { low: 800, medium: 500, high: 300 },
      transport_minutes: { low: 25, medium: 20, high: 15 },
      transport_required: { low: false, medium: true, high: true },
    },
  },
];

const POS = { position_id: "P1", name: "点位一", at: [100, 30], risk: "medium", window: { start: "2026-10-04T09:00:00Z", end: "2026-10-04T10:00:00Z" } };

function baseSnapshot(over = {}) {
  return {
    events: [{ event_id: "E", group: "road_run", positions: [POS] }],
    capability_matrix: { road_run: ["cardiac"] },
    regulations: REGS,
    teams: [
      { team_id: "T1", qual_level: "emt", at: [100.001, 30], speed_kmh: 60, credentials: [{ issued: "2025-01-01T00:00:00Z", expires: "2028-01-01T00:00:00Z" }] },
      { team_id: "T2", qual_level: "first_aid_cert", at: [100.002, 30], speed_kmh: 60, credentials: [{ issued: "2025-01-01T00:00:00Z", expires: "2028-01-01T00:00:00Z" }] },
    ],
    devices: [
      { device_id: "D1", kind: "AED", status: "ready", at: [100.001, 30], battery_expires: "2028-01-01T00:00:00Z", pad_expires: "2028-01-01T00:00:00Z" },
    ],
    vehicles: [
      { vehicle_id: "V1", status: "ready", at: [100.001, 30], speed_kmh: 60 },
    ],
    hospitals: [
      { hospital_id: "H1", capabilities: ["cardiac"], at: [100.01, 30], emergency_window: { start: "2026-10-04T00:00:00Z", end: "2026-10-04T23:59:00Z" } },
    ],
    corridors: [
      { corridor_id: "C1", status: "open", serves_positions: ["P1"], to_hospital_id: "H1", minutes: 8 },
    ],
    ...over,
  };
}

test("基线：资质合格队伍、就近 AED、通道、医院与车辆全部就位", () => {
  const sched = buildSchedule(baseSnapshot());
  assert.ok(isConflictFree(sched));
  const r = responseAt(sched, "2026-10-04T09:12:00Z", "P1");
  assert.equal(r.assignment.team_id, "T1");
  assert.equal(r.assignment.backup_team_id, "T2");
  assert.equal(r.assignment.aed_id, "D1");
  assert.equal(r.assignment.vehicle_id, "V1");
  assert.equal(r.assignment.corridor_id, "C1");
  assert.equal(r.assignment.hospital_id, "H1");
  assert.equal(r.assignment.regulation_version, "R1");
});

test("全部 AED 故障时给出 NO_AED_READY 冲突", () => {
  const snap = baseSnapshot({ devices: [{ device_id: "D1", kind: "AED", status: "fault", at: [100.001, 30], battery_expires: "2028-01-01T00:00:00Z", pad_expires: "2028-01-01T00:00:00Z" }] });
  const sched = buildSchedule(snap);
  assert.equal(isConflictFree(sched), false);
  assert.ok(sched.bySlot.get(Date.parse("2026-10-04T09:10:00Z")).conflicts.some((c) => c.code === CONFLICT_CODES.NO_AED));
});

test("无合格资质队伍：初级证不满足高风险 EMT 要求", () => {
  const snap = baseSnapshot({
    events: [{ event_id: "E", group: "road_run", positions: [{ ...POS, risk: "high" }] }],
    teams: [{ team_id: "T9", qual_level: "first_aid", at: [100.001, 30], speed_kmh: 60, credentials: [{ issued: "2025-01-01T00:00:00Z", expires: "2028-01-01T00:00:00Z" }] }],
  });
  const sched = buildSchedule(snap);
  const frame = sched.bySlot.get(Date.parse("2026-10-04T09:10:00Z"));
  assert.ok(frame.conflicts.some((c) => c.code === CONFLICT_CODES.NO_TEAM));
});

test("医院能力不匹配人群时 NO_CAPABLE_HOSPITAL", () => {
  const snap = baseSnapshot({
    capability_matrix: { road_run: ["geriatric"] },
    hospitals: [{ hospital_id: "H1", capabilities: ["cardiac"], at: [100.01, 30] }],
  });
  const sched = buildSchedule(snap);
  const frame = sched.bySlot.get(Date.parse("2026-10-04T09:10:00Z"));
  assert.ok(frame.conflicts.some((c) => c.code === CONFLICT_CODES.NO_HOSPITAL));
});

test("通道封闭且无备用通道时 NO_CORRIDOR", () => {
  const sched = buildSchedule(baseSnapshot(), { corridor_overrides: [{ corridor_id: "C1", status: "closed" }] });
  const frame = sched.bySlot.get(Date.parse("2026-10-04T09:10:00Z"));
  assert.ok(frame.conflicts.some((c) => c.code === CONFLICT_CODES.NO_CORRIDOR));
});

test("首选通道封闭后自动改走通往另一家合格医院的备用通道", () => {
  const snap = baseSnapshot({
    hospitals: [
      { hospital_id: "H1", capabilities: ["cardiac"], at: [100.01, 30] },
      { hospital_id: "H2", capabilities: ["cardiac"], at: [100.012, 30] },
    ],
    corridors: [
      { corridor_id: "C1", status: "closed", serves_positions: ["P1"], to_hospital_id: "H1", minutes: 8 },
      { corridor_id: "C2", status: "open", serves_positions: ["P1"], to_hospital_id: "H2", minutes: 9 },
    ],
  });
  const r = responseAt(buildSchedule(snap), "2026-10-04T09:12:00Z", "P1");
  assert.equal(r.assignment.corridor_id, "C2");
  assert.equal(r.assignment.hospital_id, "H2");
});

test("高温覆盖把岗位风险从 low 升到 medium，不升级窗外槽位", () => {
  const snap = baseSnapshot({
    events: [{ event_id: "E", group: "road_run", positions: [{ ...POS, risk: "low" }] }],
  });
  const before = responseAt(buildSchedule(snap), "2026-10-04T09:12:00Z", "P1").assignment;
  assert.equal(before.risk, "low");
  assert.equal(before.vehicle_id, null);
  const sched = buildSchedule(snap, { heat: [{ position_ids: ["P1"], window: { start: "2026-10-04T09:00:00Z", end: "2026-10-04T09:30:00Z" } }] });
  assert.equal(responseAt(sched, "2026-10-04T09:12:00Z", "P1").assignment.risk, "medium");
  assert.equal(responseAt(sched, "2026-10-04T09:40:00Z", "P1").assignment.risk, "low");
});

test("pins 锁定的岗位不参与重排，且仍占住其资源", () => {
  const sched = buildSchedule(baseSnapshot());
  const pinned = [...sched.bySlot.values()][0].assignments[0];
  const altered = { ...pinned, team_id: "FAKE_LOCKED" };
  const rebuilt = buildSchedule(baseSnapshot(), {
    pins: [{ ...altered }],
    team_blacklist: ["T1", "T2"],
  });
  const got = rebuilt.bySlot.get(altered.slot).assignments.find((a) => a.position_id === "P1");
  assert.equal(got.team_id, "FAKE_LOCKED");
});

test("同一资源在同一槽位不会被两个点位同时占用", () => {
  const second = { ...POS, position_id: "P2", name: "点位二", at: [100.001, 30] };
  const snap = baseSnapshot({ events: [{ event_id: "E", group: "road_run", positions: [POS, second] }] });
  const sched = buildSchedule(snap);
  const frame = sched.bySlot.get(Date.parse("2026-10-04T09:10:00Z"));
  const teams = frame.assignments.map((a) => a.team_id);
  assert.equal(new Set(teams).size, teams.length);
});
