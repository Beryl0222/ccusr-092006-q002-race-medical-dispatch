// 演练脚本：按指定时刻逐步验证"任一点位的响应者与转运交接"，
// 并演示签署门槛、四类局部重排、突发抢占补位、通知幂等与健康资料隔离。
// 运行：node src/drill.js

import { readFile } from "node:fs/promises";
import { HealthVault } from "./domain.js";
import { Orchestrator } from "./orchestrator.js";

const AT = "2026-10-04T09:12:00+08:00";
const POSITIONS = {
  P_RUN_KM5: "路跑5公里补给点",
  P_FIELD_1: "一号球场边线医疗点",
  P_WALK_PARK: "滨海步道中点",
};

function hr(title) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

function brief(a) {
  if (!a) return "（该时刻无在岗指派）";
  return [
    `风险=${a.risk}`,
    `救护队=${a.team_name ?? a.team_id}（${a.team_eta_min}分钟到，备援 ${a.backup_team_name ?? a.backup_team_id ?? "无"}）`,
    `AED=${a.aed_name ?? a.aed_id}（${a.aed_distance_m}米）`,
    a.vehicle_id ? `救护车=${a.vehicle_name ?? a.vehicle_id}` : "车辆=低风险点位按规范无需预置车辆",
    `转运=${a.corridor_name ?? a.corridor_id}`,
    `交接医院=${a.hospital_name ?? a.hospital_id}（能力 ${a.handoff_capabilities.join("+")}）`,
    `交接预计 ${a.handoff_eta_min} 分钟`,
    `依据规范=${a.regulation_version}`,
  ].join("\n  ");
}

async function main() {
  const snapshot = JSON.parse(await readFile(new URL("../data/weekend_scenario.json", import.meta.url), "utf8"));
  const health = JSON.parse(await readFile(new URL("../data/restricted_health_vault.json", import.meta.url), "utf8"));
  const vault = new HealthVault(health.records);
  const o = new Orchestrator({ snapshot, healthVault: vault, signers: snapshot.signers, clock: () => "2026-10-04T09:13:00+08:00" });

  hr("0. 签署门槛：无权人员与授权过期人员不能让方案生效");
  for (const signer_id of ["S_HE", "S_RET"]) {
    try {
      o.approvePlan({ at: AT, signer_id });
      console.log(`✗ ${signer_id} 竟然签署成功`);
    } catch (e) {
      console.log(`✓ ${signer_id} 被拒绝：${e.message}（${e.code}）`);
    }
  }

  hr("1. 安全负责人签署：无冲突 + QSM-2026-B 规范生效，方案才可批准");
  const approved = o.approvePlan({ at: "2026-10-03T10:00:00+08:00", signer_id: "S_LIN", plan_id: "weekend-medical-2026-10-04" });
  console.log(`方案 ${approved.plan_id} 已生效，签署摘要 ${approved.signature.slice(0, 16)}…，初始任务 ${approved.tasks_notified.total} 份`);

  hr("2. 09:12 三处同时出现伤情：不用打电话抢资源，直接读出接手方");
  for (const [pid, label] of Object.entries(POSITIONS)) {
    const { assignment, conflicts } = o.responseAt(AT, pid);
    console.log(`\n【${label} ${pid}】\n  ${brief(assignment)}`);
    if (conflicts.length) console.log(`  冲突：${JSON.stringify(conflicts)}`);
  }

  hr("3. 高温橙色预警（09:00-10:30 覆盖老年健步）：只重排两个步道点位");
  const heat = o.applyHeatWarning({
    at: "2026-10-04T08:30:00+08:00",
    operator: "指挥中心值班员",
    window: { start: "2026-10-04T09:00:00+08:00", end: "2026-10-04T10:30:00+08:00" },
    position_ids: ["P_WALK_PARK", "P_WALK_END"],
  });
  console.log("受影响岗位：", heat.record.impacted.join("、"));
  console.log("步道中点调整后：\n  " + brief(o.responseAt(AT, "P_WALK_PARK").assignment));
  const runAfterHeat = o.responseAt(AT, "P_RUN_KM5").assignment;
  console.log(`路跑5公里点未受波及：${runAfterHeat.team_id} / ${runAfterHeat.aed_id}`);

  hr("4. 证照到期：T_VOL_A 救护员证失效，只重排用它的岗位");
  const cred = o.reportCredentialExpiry({ at: "2026-10-04T09:05:00+08:00", operator: "急救站值班员", team_id: "T_VOL_A" });
  console.log("受影响岗位：", cred.record.impacted.join("、"));
  const km5 = o.responseAt(AT, "P_RUN_KM5").assignment;
  console.log("路跑5公里点新主责：\n  " + brief(km5));

  hr("5. 设备故障：补给点 AED_09 自检失败");
  const dev = o.reportDeviceFailure({ at: "2026-10-04T09:08:00+08:00", operator: "志愿队设备员", device_id: "AED_09" });
  console.log("受影响岗位：", dev.record.impacted.join("、"));
  console.log("路跑5公里点：\n  " + brief(o.responseAt(AT, "P_RUN_KM5").assignment));

  hr("6. 路线改变：去儿童医院通道临时封闭，自动改走市第一医院");
  o.rerouteCorridor({ at: "2026-10-04T09:10:00+08:00", operator: "交警联络人", corridor_id: "C_FIELD_CHILD", status: "closed" });
  console.log("一号球场：\n  " + brief(o.responseAt(AT, "P_FIELD_1").assignment));

  hr("7. 突发事件：南门入口踩踏（高风险），可抢占低风险点位但原任务同步补位+升级");
  const inc = o.declareIncident({
    at: "2026-10-04T09:13:00+08:00",
    operator: "指挥中心值班员",
    window_minutes: 30,
    ephemeral: {
      position_id: "P_INC_GATE",
      name: "南门入口突发踩踏（虚构）",
      at: [118.095, 24.457],
      group: "youth_ball",
      corridor_id: "C_INC_CHILD",
      corridor_minutes: 10,
      to_hospital_id: "H_CHILDREN",
    },
  });
  console.log("突发事件现场：\n  " + brief(o.responseAt("2026-10-04T09:15:00+08:00", "P_INC_GATE").assignment));
  console.log("\n补位与升级记录：");
  const seen = new Set();
  for (const e of inc.escalations) {
    const key = e.position_id;
    if (seen.has(key)) continue;
    seen.add(key);
    const b = inc.backfills.find((x) => x.position_id === key);
    console.log(`- ${key}：被抢 ${b.stolen_fields.join("、")} → 补位状态=${e.status}，升级通知=${e.notified.join("、")}`);
  }
  const start = o.responseAt("2026-10-04T09:15:00+08:00", "P_RUN_START").assignment;
  console.log(`\n同为高风险的路响起终点未被抢占：${start.team_id} / ${start.aed_id} / ${start.vehicle_id}`);

  hr("8. 重复通知不生成两份任务");
  const fp = "manual:evacuate-south-gate";
  const n1 = o.notify({ fingerprint: fp, adjustment_id: inc.adjustment_id, position_id: "P_INC_GATE", role: "team", instruct: "南门疏散广播" });
  const n2 = o.notify({ fingerprint: fp, adjustment_id: inc.adjustment_id, position_id: "P_INC_GATE", role: "team", instruct: "南门疏散广播" });
  console.log(`第一次 created=${n1.created}，第二次 created=${n2.created}；任务总数 ${o.listTasks().length}`);

  hr("9. 管理端解释：每次调整的原因、差异与冲突");
  for (const r of o.auditLog().slice(-3)) {
    console.log(`- [${r.id}] ${r.type} ${r.reason}，影响 ${r.impacted.join("、") || "（仅新增点位）"}，遗留冲突 ${r.conflicts.length}`);
  }

  hr("10. 健康资料隔离：公开赛事视图看不到任何真实个人健康资料");
  const pub = JSON.stringify(o.publicState());
  const leaks = vault.sensitiveTokens().filter((token) => pub.includes(token));
  console.log(`公开视图字符数 ${pub.length}，命中受限健康词条 ${leaks.length} 个：${leaks.length ? leaks.join("、") : "无"}`);
  try {
    o.readHealthRecords({ role: "volunteer", scopes: [] });
  } catch (e) {
    console.log(`无授权读取健康库被拒绝：${e.code}`);
  }
  const records = o.readHealthRecords({ role: "medical_officer", scopes: ["phi"] });
  console.log(`医疗官凭 phi 授权可读 ${records.length} 条受限记录，访问留痕 ${vault.accessLog.length} 条（含被拒绝的一次）`);

  console.log("\n演练结束。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
