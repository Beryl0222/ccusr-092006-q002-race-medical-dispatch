// race_medical_dispatch 领域资料的基础结构：事件种类与最小字段校验。
// 编排服务（scheduler/orchestrator）在这些事件术语下工作，此文件仅作领域约定。

export const EVENT_KINDS = Object.freeze([
  "EVENT_RISK_FILED", // 主办方提交赛事路线/时段/人群/风险评估
  "RESOURCE_DECLARED", // 医院、急救站、志愿团队登记人员资质、车辆设备与交接能力
  "REGULATION_VERSIONED", // 安全规范发布新版本（含生效起止）
  "PLAN_APPROVED", // 有权人员签署，方案生效
  "PLAN_SIGNING_REJECTED", // 无权签署或存在资源冲突，方案未生效
  "HEAT_WARNING_ISSUED", // 高温预警，覆盖岗位风险升级
  "CREDENTIAL_EXPIRED", // 人员证照到期，相关岗位停用重排
  "DEVICE_FAILURE_REPORTED", // 设备故障，相关岗位重排
  "CORRIDOR_REROUTED", // 转运路线改变
  "POSITION_WINDOW_CHANGED", // 点位时段调整
  "INCIDENT_DECLARED", // 突发事件，按高风险抢占低风险点位
  "LOW_RISK_BACKFILLED", // 被抢占岗位完成补位
  "INCIDENT_ESCALATED", // 补不齐或冲突未解，升级通知
  "TASK_DISPATCHED", // 幂等任务派发（重复通知不产生第二份）
  "HANDOFF_COMPLETED", // 现场到医院的交接完成
  "HEALTH_ACCESS_GRANTED", // 受限健康库授权读取（留痕）
  "HEALTH_ACCESS_DENIED", // 受限健康库读取被拒绝（留痕）
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
