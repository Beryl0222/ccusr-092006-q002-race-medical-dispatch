// 单元测试：审批闸门、求解器规则、越权与补位失败升级。
import assert from "node:assert/strict";
import test from "node:test";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { replay } from "../src/runner.js";
import { buildGraph, aedEligible, teamEligible } from "../src/scheduler.js";
import { normAt } from "../src/norms.js";

const H2 = "norm-2026-h2";
const DAY = "2026-10-10T09:00:00+08:00";
const FUTURE = "2027-12-31T00:00:00+08:00";

function team(id, cert, ref = "ST", owner = "station") {
  const members = [
    { member_id: `${id}a`, cert, expires_at: FUTURE },
    { member_id: `${id}b`, cert, expires_at: FUTURE },
  ];
  return { command_id: `d-${id}`, kind: "declare_resource", occurred_at: "2026-09-01T08:00:00+08:00", actor: { org: owner }, resource: { id, kind: "team", owner_org: owner, ref, members } };
}
function aed(id, ref = "ST", owner = "host") {
  return { command_id: `d-${id}`, kind: "declare_resource", occurred_at: "2026-09-01T08:00:00+08:00", actor: { org: owner }, resource: { id, kind: "aed", owner_org: owner, status: "ready", ref } };
}
function facility(id, capabilities, ref) {
  return { command_id: `d-${id}`, kind: "declare_resource", occurred_at: "2026-09-01T08:00:00+08:00", actor: { org: "hospital" }, resource: { id, kind: "facility", owner_org: "hospital", capabilities, ref, window: { start: "2026-10-10T06:00:00+08:00", end: "2026-10-10T18:00:00+08:00" } } };
}
function vehicle(id, type = "ambulance", ref = "VP") {
  return { command_id: `d-${id}`, kind: "declare_resource", occurred_at: "2026-09-01T08:00:00+08:00", actor: { org: "station" }, resource: { id, kind: "vehicle", owner_org: "station", type, ref } };
}
function route(id, path, allowed) {
  return { command_id: `d-${id}`, kind: "declare_resource", occurred_at: "2026-09-01T08:00:00+08:00", actor: { org: "host" }, resource: { id, kind: "route", owner_org: "host", path, allowed_injuries: allowed } };
}

function planCmd(planId, overrides = {}) {
  return {
    command_id: `s-${planId}`,
    kind: "submit_plan",
    occurred_at: "2026-09-20T09:00:00+08:00",
    actor: { org: "host" },
    plan: {
      plan_id: planId,
      norm_id: H2,
      activities: [{ id: "A1", type: "youth_ball", region: "r", label: "x", window: { start: "2026-10-10T08:00:00+08:00", end: "2026-10-10T12:00:00+08:00" } }],
      posts: [
        {
          id: "P1",
          label: "p1",
          kind: "sideline",
          activity_id: "A1",
          activity_type: "youth_ball",
          region: "r",
          ref: "p1",
          risk: "MEDIUM",
          injury_focus: "TRAUMA",
          window: { start: "2026-10-10T08:00:00+08:00", end: "2026-10-10T12:00:00+08:00" },
          ...overrides,
        },
      ],
      setup: { start: "2026-10-10T07:20:00+08:00" },
      teardown: { end: "2026-10-10T12:40:00+08:00" },
      links: [
        { a: "ST", b: "p1", minutes: 2 },
        { a: "VP", b: "p1", minutes: 2 },
        { a: "p1", b: "H1", minutes: 10 },
      ],
    },
  };
}
const approve = (planId, signer = { role: "SAFETY_DIRECTOR" }, when = "2026-09-21T09:00:00+08:00", cid = `a-${planId}`) => ({
  command_id: cid,
  kind: "approve_plan",
  occurred_at: when,
  plan_id: planId,
  signer,
});

function baseCommands() {
  return [
    team("T_FA", "FIRST_AID", "ST", "volunteer"),
    team("T_EMT", "EMT", "ST"),
    aed("A1", "p1"),
    facility("H1", ["TRAUMA", "PEDIATRIC"]),
    vehicle("V1"),
    route("R1", ["p1", "H1"], ["TRAUMA", "PEDIATRIC"]),
  ];
}

test("未签署或签署人无权 → 方案不生效", () => {
  const { engine } = replay(baseCommands().concat(planCmd("P")));
  const noSigner = engine.handle(approve("P", null));
  assert.equal(noSigner.conflicts[0].code, "UNSIGNED_OR_UNAUTHORIZED");
  const wrongRole = engine.handle({ ...approve("P", { role: "VOLUNTEER" }), command_id: "a2" });
  assert.equal(wrongRole.conflicts[0].code, "UNSIGNED_OR_UNAUTHORIZED");
  assert.equal(engine.snapshotAt(Date.parse(DAY)).assignments.size, 0);
});

test("布撤场缓冲不足 → WINDOW_UNCOVERED", () => {
  const engine = new Engine(new Store());
  for (const c of baseCommands()) engine.handle(c);
  const bad = planCmd("PBUF2");
  bad.plan.setup = { start: "2026-10-10T07:50:00+08:00" }; // 仅提前 10 分钟 < 40
  engine.handle(bad);
  const r = engine.handle(approve("PBUF2", { role: "SAFETY_DIRECTOR" }, "2026-09-21T09:00:00+08:00", "a-PBUF2"));
  assert.equal(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.code === "WINDOW_UNCOVERED"));
});

test("高风险路跑需要 PARAMEDIC；资质不足 → 审批被驳回", () => {
  const cmds = baseCommands();
  // 只有 FIRST_AID / EMT，没有 PARAMEDIC
  const p = planCmd("PRUN", { activity_type: "road_run", risk: "HIGH", injury_focus: "CARDIAC" });
  p.plan.activities[0].type = "road_run";
  cmds.push(p, approve("PRUN"));
  const { results } = replay(cmds);
  const r = results.find((x) => x.command_id === "a-PRUN");
  assert.equal(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.code === "CERT_MISSING"));
});

test("非归属机构不能维护资源（OWNER_SCOPE）", () => {
  const { engine } = replay(baseCommands().concat(planCmd("PW"), approve("PW")));
  const r = engine.handle({
    command_id: "n1",
    kind: "resource_notice",
    occurred_at: DAY,
    actor: { org: "volunteer" }, // A1 属于 host
    notice: { notice_id: "nt1", type: "EQUIPMENT_FAULT", resource_id: "A1", window: [DAY, "2026-10-10T10:00:00+08:00"] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0].code, "OWNER_SCOPE");
});

test("非医院不能写 PHI 分区", () => {
  const engine = new Engine(new Store());
  const r = engine.handle({
    command_id: "phi1",
    kind: "record_phi",
    occurred_at: DAY,
    actor: { org: "host" },
    phi: { phi_id: "x", incident_id: "i", content: { a: 1 } },
  });
  assert.equal(r.conflicts[0].code, "PHI_SCOPE");
  assert.equal(engine.store.phiEvents.length, 0);
});

test("无可补位资源时抢占 → NO_BACKFILL 升级，指挥中心可见缺口", () => {
  // 只有两支队伍：FIRST_AID 驻 P1（事发点），唯一的 EMT 驻 LOW 点 P2；P2 无补位队
  const cmds = [
    team("T_FA", "FIRST_AID", "p1", "volunteer"),
    team("T_EMT", "EMT", "p2"),
    aed("A1", "p1"),
    aed("A2", "p2"),
    facility("H1", ["TRAUMA"]),
    vehicle("V1"),
    route("R1", ["p1", "H1"], ["TRAUMA"]),
  ];
  const p = planCmd("PP");
  p.plan.posts.push({
    id: "P2",
    label: "low",
    kind: "standby",
    activity_id: "A1",
    activity_type: "youth_ball",
    region: "r",
    ref: "p2",
    risk: "LOW",
    injury_focus: "TRAUMA",
    window: { start: "2026-10-10T08:00:00+08:00", end: "2026-10-10T12:00:00+08:00" },
  });
  p.plan.links.push({ a: "p1", b: "p2", minutes: 3 }, { a: "p2", b: "H1", minutes: 9 });
  cmds.push(p, approve("PP"));
  const { engine } = replay(cmds);
  const r = engine.handle({
    command_id: "inc1",
    kind: "report_incident",
    occurred_at: DAY,
    actor: { org: "station" },
    incident: { incident_id: "I1", post_id: "P1", injury: "TRAUMA", severity: "HIGH" },
  });
  assert.equal(r.ok, false);
  assert.ok(r.decision.conflicts.some((c) => c.code === "NO_BACKFILL"));
  const st = engine.snapshotAt(Date.parse(DAY));
  assert.ok(st.escalations.some((e) => e.escalation === "NO_BACKFILL" && e.post_id === "P2"));
});

test("AED 响应：常温 4 分钟达标、高温 3 分钟限制下不达标", () => {
  const norm = normAt(Date.parse(DAY));
  const graph = buildGraph([{ a: "A1", b: "p1", minutes: 4 }]);
  const post = { ref: "p1", risk: "LOW", activity_type: "youth_ball" };
  const a = { id: "A1", kind: "aed", status: "ready", ref: "A1" };
  assert.equal(aedEligible(a, { post, graph, norm, heat: false, atStart: 0, atEnd: 1 }).ok, true);
  const hot = aedEligible(a, { post, graph, norm, heat: true, atStart: 0, atEnd: 1 });
  assert.equal(hot.ok, false);
  assert.equal(hot.reasons[0].code, "AED_RESPONSE");
});

test("图最短路取更小值（双向、多路径）", () => {
  const g = buildGraph([
    { a: "x", b: "y", minutes: 5 },
    { a: "x", b: "z", minutes: 1 },
    { a: "z", b: "y", minutes: 1 },
  ]);
  assert.equal(g.minutes("x", "y"), 2);
  assert.equal(g.minutes("y", "x"), 2);
  assert.equal(g.minutes("x", "q"), Infinity);
});

test("证照在任务结束前到期 → 班组不合格", () => {
  const norm = normAt(Date.parse(DAY));
  const expiredTeam = {
    id: "T",
    kind: "team",
    members: [
      { cert: "EMT", expires_at: "2026-10-09T00:00:00+08:00" },
      { cert: "EMT", expires_at: FUTURE },
    ],
  };
  const post = { ref: "p1", risk: "MEDIUM", activity_type: "road_run" };
  const el = teamEligible(expiredTeam, { post, norm, atStart: Date.parse(DAY), atEnd: Date.parse("2026-10-10T12:00:00+08:00") });
  // 仅剩 1 名合格成员 < 2
  assert.ok(el.reasons.some((r) => r.code === "TEAM_SIZE"));
});
