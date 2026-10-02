// 端到端：周末三活动同发演练场景的不变量。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { replay } from "../src/runner.js";
import { drillView, adminView, publicView } from "../src/views.js";

const T1000 = "2026-10-10T10:00:00+08:00";

async function load() {
  const doc = JSON.parse(await readFile(new URL("../data/scenario.json", import.meta.url), "utf8"));
  return replay(doc.commands);
}

test("旧规范方案被驳回、重提后才生效，只有签署方案能产生编排", async () => {
  const { results, engine } = await load();
  const v1 = results.find((r) => r.command_id === "cmd-plan-v1-approve");
  const v2 = results.find((r) => r.command_id === "cmd-plan-v2-approve");
  assert.equal(v1.ok, false);
  assert.equal(v1.conflicts[0].code, "NORM_VERSION_MISMATCH");
  assert.equal(v2.ok, true);

  const admin = adminView(engine, { asOf: Date.parse(T1000) });
  const plans = Object.fromEntries(admin.plans.map((p) => [p.plan_id, p.status]));
  assert.deepEqual(plans, { "PLAN-20261010-v1": "rejected", "PLAN-20261010-v2": "approved" });
  assert.equal(admin.posts.length, 6);
  assert.ok(admin.posts.every((p) => p.covered));
});

test("三起伤情同时发生时，各自立即确定救护队/AED/转运链路且互不抢占同一资源", async () => {
  const { engine } = await load();
  const st = engine.snapshotAt(Date.parse("2026-10-10T10:01:00+08:00"));
  const decisions = ["INC-1001", "INC-1002", "INC-1003"].map((id) => ({ id, d: st.incidents.get(id).opened.decision }));

  assert.deepEqual(
    decisions.map((x) => x.d.conflicts.length),
    [0, 0, 0],
  );
  // 队伍、AED、车辆互不重复
  const teams = decisions.map((x) => x.d.team_id);
  const aeds = decisions.map((x) => x.d.aed_id);
  const vehicles = decisions.map((x) => x.d.chain.vehicle_id);
  assert.equal(new Set(teams).size, 3);
  assert.equal(new Set(aeds).size, 3);
  assert.equal(new Set(vehicles).size, 3);

  // 路跑心脏骤停 → 重症组 + 现场 AED + 胸痛医院，走管制后的备用线，ETA 达标
  const run = decisions[0].d;
  assert.equal(run.team_id, "T_PARAM");
  assert.equal(run.chain.route_id, "R_RUN_B");
  assert.equal(run.chain.facility_id, "H_MAIN");
  assert.ok(run.chain.eta_min <= 15);

  // 老年跌倒 → 担架车 + 担架接诊点
  const walk = decisions[2].d;
  assert.equal(walk.chain.vehicle_id, "V3");
  assert.equal(walk.chain.facility_id, "H_GERI");
});

test("突发事件只能抢占低风险点位，且原岗位同步获得补位并记录升级", async () => {
  const { engine } = await load();
  const st = engine.snapshotAt(Date.parse("2026-10-10T10:01:00+08:00"));
  const ball = st.incidents.get("INC-1002").opened.decision;
  assert.equal(ball.team_preempted, true);
  assert.equal(ball.team_source_post_id, "P_GATE"); // 入口值守是 LOW
  assert.equal(ball.preempts.length, 1);
  const pre = ball.preempts[0];
  assert.equal(pre.donor_post_id, "P_GATE");
  assert.ok(pre.replacement, "原岗位必须有补位");
  assert.equal(pre.replacement.team_id, "T_RES1");

  // 管理端可看到抢占调整 + PREEMPTED_WITH_BACKFILL 升级
  const admin = adminView(engine, { asOf: Date.parse("2026-10-10T10:01:00+08:00") });
  assert.ok(admin.escalations.some((e) => e.escalation === "PREEMPTED_WITH_BACKFILL" && e.post_id === "P_GATE"));
  assert.ok(admin.adjustments.some((a) => a.reason === "EMERGENCY_PREEMPT"));
});

test("高温/证照/设备/路线通知只重排受影响岗位与槽位", async () => {
  const { engine } = await load();
  const at = Date.parse("2026-10-10T09:35:00+08:00");
  const st = engine.snapshotAt(at);
  // 高温只作用于 riverside，球场与健步不在高温范围
  assert.equal(st.assignments.get("P_RUN_5K").heat, true);
  assert.equal(st.assignments.get("P_BALL").heat, false);
  // AED 故障：P_WALK 队伍不变，仅 AED 换成备用机
  assert.equal(st.assignments.get("P_WALK").team_id, "T_FA_WALK");
  assert.equal(st.assignments.get("P_WALK").aed_id, "A_SPARE");
  // 证照到期：P_RUN_10K 换组（AED 保留）
  assert.equal(st.assignments.get("P_RUN_10K").team_id, "T_EMT_R2");
  assert.equal(st.assignments.get("P_RUN_10K").aed_id, "A2");
  // 路线管制：5 公里点链路切到备用线
  assert.equal(st.assignments.get("P_RUN_5K").chain.route_id, "R_RUN_B");
});

test("重复通知不再生成第二份任务，只留 NOTICE_SUPPRESSED", async () => {
  const { results, store } = await load();
  const dup = results.find((r) => r.command_id === "cmd-heat-1-dup");
  assert.equal(dup.ok, true);
  assert.equal(dup.duplicated, true);
  assert.deepEqual(dup.event_ids, ["supp#notice-heat-riverside-0905"]);
  const heatAdj = store.read().filter((e) => e.kind === "ADJUSTMENT" && e.payload.reason === "HEAT");
  assert.equal(heatAdj.length, 1, "同一条高温预警只能产生一次调整");
});

test("交接幂等：重复交接被拒绝；PHI 与公开视图物理隔离", async () => {
  const { results, store, engine } = await load();
  const handoff = results.find((r) => r.command_id === "cmd-handoff-walk");
  const dupHandoff = results.find((r) => r.command_id === "cmd-handoff-walk-dup");
  assert.equal(handoff.ok, true);
  assert.equal(dupHandoff.ok, false);
  assert.equal(dupHandoff.conflicts[0].code, "DUPLICATE_TASK");

  assert.equal(store.readPhi().length, 1);
  assert.ok(!store.read().some((e) => e.kind === "PHI_RECORDED"));

  const pub = JSON.stringify(publicView(engine, { asOf: Date.parse(T1000) }));
  assert.ok(!pub.includes("髋部骨折"));
  assert.ok(!pub.includes("member"));
  assert.equal(JSON.parse(pub).phi_included, false);
});

test("演练视图只读推演：给定时刻与伤情能解释接手者与转运交接", async () => {
  const { engine } = await load();
  const v = drillView(engine, { at: "2026-10-10T09:59:00+08:00", post_id: "P_WALK", injury: "SENIOR_FALL" });
  assert.equal(v.ok, true);
  assert.equal(v.responder.team.id, "T_FA_WALK");
  assert.equal(v.handoff.vehicle.id, "V3");
  assert.equal(v.handoff.facility.id, "H_GERI");
  assert.ok(v.handoff.eta_min <= v.handoff.eta_limit_min);

  // 无儿科能力医院时，演练必须暴露冲突而不是静默成功
  const pediatric = drillView(engine, { at: T1000, post_id: "P_BALL", injury: "PEDIATRIC" });
  assert.ok(pediatric.conflicts.some((c) => c.code === "VEHICLE_UNAVAILABLE" || c.code === "FACILITY_CAPABILITY"));
});

test("command_id 幂等：同一命令重放返回首次结果", async () => {
  const { engine, store } = await load();
  const before = store.events.length;
  const r2 = engine.handle({
    command_id: "cmd-inc-run-1000",
    kind: "report_incident",
    occurred_at: T1000,
    incident: { incident_id: "INC-1001", post_id: "P_RUN_5K", injury: "CARDIAC", severity: "CRITICAL" },
  });
  assert.equal(r2.replayed, true);
  assert.equal(store.events.length, before);
});
