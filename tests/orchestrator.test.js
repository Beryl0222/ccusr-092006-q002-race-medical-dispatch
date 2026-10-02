import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HealthVault } from "../src/domain.js";
import { Orchestrator } from "../src/orchestrator.js";

const SCENARIO_URL = new URL("../data/weekend_scenario.json", import.meta.url);
const HEALTH_URL = new URL("../data/restricted_health_vault.json", import.meta.url);
const AT = "2026-10-04T09:12:00+08:00";

async function boot({ mutate, clock = () => "2026-10-04T09:13:00+08:00", health = true } = {}) {
  const snapshot = JSON.parse(await readFile(SCENARIO_URL, "utf8"));
  if (mutate) mutate(snapshot);
  let vault = null;
  if (health) {
    const h = JSON.parse(await readFile(HEALTH_URL, "utf8"));
    vault = new HealthVault(h.records);
  }
  const o = new Orchestrator({ snapshot, healthVault: vault, signers: snapshot.signers, clock });
  return { o, snapshot };
}

async function signed(options) {
  const ctx = await boot(options);
  ctx.o.approvePlan({ at: "2026-10-03T10:00:00+08:00", signer_id: "S_LIN", plan_id: "plan-base" });
  return ctx;
}

const INCIDENT = {
  position_id: "P_INC_GATE",
  name: "南门入口突发踩踏（虚构）",
  at: [118.095, 24.457],
  group: "youth_ball",
  corridor_id: "C_INC_CHILD",
  corridor_minutes: 10,
  to_hospital_id: "H_CHILDREN",
};

// ---------- 签署门槛 ----------

test("无签署方案时任何响应查询都被拒绝", async () => {
  const { o } = await boot();
  assert.throws(() => o.responseAt(AT, "P_RUN_KM5"), (e) => e.code === "PLAN_NOT_EFFECTIVE");
});

test("无权签署人与授权过期者不能使方案生效", async () => {
  const { o } = await boot();
  assert.throws(() => o.approvePlan({ at: AT, signer_id: "S_HE" }), (e) => e.code === "SIGNER_UNAUTHORIZED");
  assert.throws(() => o.approvePlan({ at: AT, signer_id: "S_RET" }), (e) => e.code === "SIGNER_UNAUTHORIZED");
  assert.equal(o.plan, null);
});

test("存在资源冲突的方案签署被拒绝并返回冲突清单", async () => {
  const { o } = await boot({ mutate: (s) => (s.vehicles = []) });
  try {
    o.approvePlan({ at: "2026-10-03T10:00:00+08:00", signer_id: "S_LIN" });
    assert.fail("应当拒绝签署");
  } catch (e) {
    assert.equal(e.code, "PLAN_HAS_CONFLICTS");
    assert.ok(e.conflicts.length > 0);
  }
});

test("有权签署且无冲突：方案生效，签名绑定数据与规范版本", async () => {
  const { o } = await signed();
  assert.equal(o.plan.plan_id, "plan-base");
  assert.match(o.plan.signature, /^[0-9a-f]{64}$/);
  assert.deepEqual(o.plan.manifest.regulation_versions.find((r) => r.version === "QSM-2026-B").version, "QSM-2026-B");
});

// ---------- 三伤并发 ----------

test("09:12 路跑/青少年球赛/老年健步同时伤情，各自立即有接手方与交接链", async () => {
  const { o } = await signed();
  const [run, field, walk] = o.responseAtMany(AT, ["P_RUN_KM5", "P_FIELD_1", "P_WALK_PARK"]);
  for (const r of [run, field]) {
    const a = r.assignment;
    assert.ok(a.team_id && a.backup_team_id && a.aed_id && a.vehicle_id && a.corridor_id && a.hospital_id);
    assert.ok(a.handoff_eta_min <= 20);
  }
  assert.equal(run.assignment.hospital_id, "H_CITY");
  assert.equal(field.assignment.hospital_id, "H_CHILDREN");
  // 老年低风险点位：有队、有 AED、有通道医院；车辆按规范不预置
  const w = walk.assignment;
  assert.ok(w.team_id && w.aed_id && w.corridor_id && w.hospital_id);
  assert.equal(w.vehicle_id, null);
  assert.equal(w.hospital_id, "H_GERI");
});

// ---------- 局部重排：只动受影响岗位 ----------

test("高温预警只升级覆盖岗位：步道两点变中风险并补车，路跑岗位逐项不变", async () => {
  const { o } = await signed();
  const runBefore = o.responseAt(AT, "P_RUN_KM5").assignment;
  const fieldBefore = o.responseAt(AT, "P_FIELD_1").assignment;
  const walkBefore = o.responseAt(AT, "P_WALK_PARK").assignment;
  assert.equal(walkBefore.risk, "low");

  const r = o.applyHeatWarning({
    at: "2026-10-04T08:30:00+08:00",
    operator: "duty",
    window: { start: "2026-10-04T09:00:00+08:00", end: "2026-10-04T10:30:00+08:00" },
    position_ids: ["P_WALK_PARK", "P_WALK_END"],
  });
  assert.deepEqual(r.record.impacted.sort(), ["P_WALK_END", "P_WALK_PARK"]);
  assert.equal(r.record.conflicts.length, 0);

  const walkAfter = o.responseAt(AT, "P_WALK_PARK").assignment;
  assert.equal(walkAfter.risk, "medium");
  assert.ok(walkAfter.vehicle_id);
  assert.deepEqual(o.responseAt(AT, "P_RUN_KM5").assignment, runBefore);
  assert.deepEqual(o.responseAt(AT, "P_FIELD_1").assignment, fieldBefore);
});

test("设备故障只重排使用该 AED 的岗位", async () => {
  const { o } = await signed();
  const before = o.responseAt(AT, "P_RUN_KM5").assignment;
  const otherBefore = o.responseAt(AT, "P_FIELD_1").assignment;
  const r = o.reportDeviceFailure({ at: "2026-10-04T09:08:00+08:00", operator: "duty", device_id: before.aed_id });
  assert.deepEqual(r.record.impacted, ["P_RUN_KM5"]);
  const after = o.responseAt(AT, "P_RUN_KM5").assignment;
  assert.notEqual(after.aed_id, before.aed_id);
  assert.equal(after.team_id, before.team_id);
  assert.deepEqual(o.responseAt(AT, "P_FIELD_1").assignment, otherBefore);
});

test("证照到期只重排用该队伍的岗位，新主责资质仍达标", async () => {
  const { o } = await signed();
  const runStartBefore = o.responseAt(AT, "P_RUN_START").assignment;
  const r = o.reportCredentialExpiry({ at: "2026-10-04T09:05:00+08:00", operator: "duty", team_id: "T_VOL_A" });
  assert.ok(r.record.impacted.includes("P_RUN_KM5"));
  const km5 = o.responseAt(AT, "P_RUN_KM5").assignment;
  assert.notEqual(km5.team_id, "T_VOL_A");
  assert.ok(km5.team_id);
  // 未使用该队伍的高风险岗位锁定不变
  assert.deepEqual(o.responseAt(AT, "P_RUN_START").assignment, runStartBefore);
  assert.equal(r.record.conflicts.length, 0);
});

test("路线改变：首选通道封闭后自动改走备用通道与医院，其他岗位不动", async () => {
  const { o } = await signed();
  const km5Before = o.responseAt(AT, "P_RUN_KM5").assignment;
  const r = o.rerouteCorridor({ at: "2026-10-04T09:10:00+08:00", operator: "duty", corridor_id: "C_FIELD_CHILD", status: "closed" });
  assert.deepEqual(r.record.impacted, ["P_FIELD_1"]);
  const f = o.responseAt(AT, "P_FIELD_1").assignment;
  assert.equal(f.corridor_id, "C_FIELD_CITY");
  assert.equal(f.hospital_id, "H_CITY");
  assert.deepEqual(o.responseAt(AT, "P_RUN_KM5").assignment, km5Before);
});

test("点位时段改变：窗内无指派、新窗内有指派", async () => {
  const { o } = await signed();
  const r = o.changePositionWindow({
    at: "2026-10-04T08:00:00+08:00",
    operator: "organizer",
    position_id: "P_FIELD_1",
    window: { start: "2026-10-04T10:00:00+08:00", end: "2026-10-04T11:00:00+08:00" },
  });
  assert.deepEqual(r.record.impacted, ["P_FIELD_1"]);
  assert.equal(o.responseAt(AT, "P_FIELD_1").assignment, null);
  assert.ok(o.responseAt("2026-10-04T10:20:00+08:00", "P_FIELD_1").assignment);
});

// ---------- 突发抢占 + 同步补位 + 升级 ----------

test("突发事件按高风险获资源；同高风险岗位不被抢；被抢占的低风险岗位同步补位并留升级记录", async () => {
  const { o } = await signed();
  const runStartBefore = o.responseAt("2026-10-04T09:15:00+08:00", "P_RUN_START").assignment;

  const r = o.declareIncident({ at: "2026-10-04T09:13:00+08:00", operator: "duty", window_minutes: 30, ephemeral: INCIDENT });
  assert.equal(r.record.conflicts.length, 0);

  const inc = o.responseAt("2026-10-04T09:15:00+08:00", "P_INC_GATE").assignment;
  assert.equal(inc.risk, "high");
  assert.ok(inc.team_id && inc.aed_id && inc.vehicle_id && inc.corridor_id && inc.hospital_id);
  assert.equal(inc.hospital_id, "H_CHILDREN");

  // 同为高风险的路响起终点资源锁定，未被抢
  assert.deepEqual(o.responseAt("2026-10-04T09:15:00+08:00", "P_RUN_START").assignment, runStartBefore);

  // 每个被抢占岗位都有补位记录（本场景资源充足，全部补齐）与升级记录
  assert.ok(r.backfills.length > 0);
  assert.ok(r.backfills.every((b) => b.status === "backfilled"));
  const positions = new Set(r.backfills.map((b) => b.position_id));
  for (const pid of positions) {
    assert.ok(r.escalations.some((e) => e.position_id === pid && e.kind === "LOW_RISK_PREEMPTED" && e.notified.includes("medical_director")));
  }

  // 窗外岗位不受影响
  const later = o.responseAt("2026-10-04T10:30:00+08:00", "P_FIELD_1");
  assert.ok(later.assignment);
});

test("资源紧绷时补不齐的岗位保持 open 升级，并通知互助协调", async () => {
  // 去掉步道备用接驳车：高温升级 + 突发抢占后必有中风险点位无车可补
  const { o } = await boot({ mutate: (s) => (s.vehicles = s.vehicles.filter((v) => v.vehicle_id !== "GOLF_4")) });
  o.approvePlan({ at: "2026-10-03T10:00:00+08:00", signer_id: "S_LIN", plan_id: "plan-tight" });
  o.applyHeatWarning({
    at: "2026-10-04T08:30:00+08:00",
    operator: "duty",
    window: { start: "2026-10-04T09:00:00+08:00", end: "2026-10-04T10:30:00+08:00" },
    position_ids: ["P_WALK_PARK", "P_WALK_END"],
  });
  const r = o.declareIncident({ at: "2026-10-04T09:13:00+08:00", operator: "duty", window_minutes: 30, ephemeral: INCIDENT });
  const open = r.escalations.filter((e) => e.status === "open");
  assert.ok(open.length > 0);
  assert.ok(open.some((e) => e.missing.includes("vehicle_id") && e.notified.includes("mutual_aid_coordinator")));
});

// ---------- 通知幂等与审计 ----------

test("重复通知只生成一份任务；同一调整重复同步也不翻倍", async () => {
  const { o } = await signed();
  const n1 = o.notify({ fingerprint: "fp-x", adjustment_id: "plan-base", position_id: "P1", role: "team", instruct: "x" });
  const n2 = o.notify({ fingerprint: "fp-x", adjustment_id: "plan-base", position_id: "P1", role: "team", instruct: "x" });
  assert.equal(n1.created, true);
  assert.equal(n2.created, false);
  const countAfterApprove = o.listTasks().length;
  o.syncTasks("plan-base", o.plan.schedule, AT);
  assert.equal(o.listTasks().length, countAfterApprove);
});

test("每次调整都可在审计中解释原因、差异岗位与遗留冲突", async () => {
  const { o } = await signed();
  o.reportDeviceFailure({ at: "2026-10-04T09:08:00+08:00", operator: "duty", device_id: "AED_09" });
  const log = o.auditLog();
  assert.equal(log[0].type, "PLAN_APPROVED");
  const adj = log.find((r) => r.type === "DEVICE_FAILURE");
  assert.ok(adj);
  assert.ok(adj.reason.includes("AED_09"));
  assert.deepEqual(adj.impacted, ["P_RUN_KM5"]);
  assert.ok(adj.diffs.some((d) => d.field === "aed_id" && d.from === "AED_09"));
  const fetched = o.explainAdjustment(adj.id);
  assert.equal(fetched.id, adj.id);
});

// ---------- 健康资料隔离 ----------

test("公开赛事视图不含任何受限健康词条；健康库读取需授权并留痕", async () => {
  const { o } = await signed();
  const vault = o.healthVault;
  const pub = JSON.stringify(o.publicState());
  for (const token of vault.sensitiveTokens()) assert.equal(pub.includes(token), false, `泄漏：${token}`);
  assert.throws(() => o.readHealthRecords({ role: "volunteer", scopes: [] }), (e) => e.code === "PHI_DENIED");
  const rows = o.readHealthRecords({ role: "medical_officer", scopes: ["phi"] });
  assert.equal(rows.length, 3);
  assert.equal(vault.accessLog.filter((x) => x.granted).length, 1);
  assert.ok(vault.accessLog.some((x) => !x.granted));
});
