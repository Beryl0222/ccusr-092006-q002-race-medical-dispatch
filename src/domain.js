// 群众赛事医疗资源编排 —— 领域常量与事件/命令类型。
// 所有资料均为虚构样例，禁止写入真实个人健康信息（PHI 走独立分区）。

export const ORGS = Object.freeze({
  HOST: "host", // 主办方
  HOSPITAL: "hospital", // 医院
  STATION: "station", // 急救站
  VOLUNTEER: "volunteer", // 志愿团队
});

export const ACTIVITY_TYPES = Object.freeze(["road_run", "youth_ball", "senior_walk"]);

export const RISK_LEVELS = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const riskRank = (r) => RISK_LEVELS.indexOf(r);

export const POST_KINDS = Object.freeze(["aid", "route_point", "sideline", "supply", "standby"]);

// 资源种类
export const RESOURCE_KINDS = Object.freeze(["team", "aed", "vehicle", "facility", "route"]);

// 证书
export const CERTS = Object.freeze(["FIRST_AID", "EMT", "PARAMEDIC", "PHYSICIAN"]);

// 医院接诊能力
export const FACILITY_CAPS = Object.freeze([
  "CARDIAC", // 胸痛/心脏骤停（导管室等）
  "TRAUMA", // 创伤
  "PEDIATRIC", // 儿科
  "STRETCHER_BAY", // 担架接诊
  "GREEN_CHANNEL", // 绿色通道
]);

// 事件（追加日志，不可变）
export const EVENT_KINDS = Object.freeze([
  // 兼容既有领域资料
  "EVENT_RISK_FILED",
  // 编排服务事件
  "RESOURCE_DECLARED",
  "RESOURCE_STATUS_CHANGED",
  "PLAN_SUBMITTED",
  "PLAN_APPROVED",
  "PLAN_WITHDRAWN",
  "NOTICE_SUPPRESSED",
  "ADJUSTMENT",
  "INCIDENT_OPENED",
  "INCIDENT_ESCALATED",
  "HANDOFF_COMPLETED",
]);

// 命令（输入）
export const COMMAND_KINDS = Object.freeze([
  "declare_resource",
  "resource_notice", // 高温/证照到期/设备故障/路线改变等通知
  "submit_plan",
  "approve_plan",
  "withdraw_plan",
  "report_incident",
  "complete_handoff",
  "record_phi", // 进入 PHI 独立分区
]);

// 通知类型
export const NOTICE_TYPES = Object.freeze(["HEAT", "CERT_EXPIRY", "EQUIPMENT_FAULT", "ROUTE_CHANGE"]);

// 调整原因（与通知类型对应，另有审批后的初始编排）
export const ADJUSTMENT_REASONS = Object.freeze([
  "INITIAL",
  "HEAT",
  "CERT_EXPIRY",
  "EQUIPMENT_FAULT",
  "ROUTE_CHANGE",
  "EMERGENCY_PREEMPT",
]);

// 冲突码 —— 管理端据此解释资源冲突
export const CONFLICT_CODES = Object.freeze({
  NORM_VERSION_MISMATCH: "NORM_VERSION_MISMATCH", // 方案引用规范已失效
  UNSIGNED_OR_UNAUTHORIZED: "UNSIGNED_OR_UNAUTHORIZED", // 未经有权人员签署
  PLAN_NOT_ACTIVE: "PLAN_NOT_ACTIVE", // 方案未生效
  CERT_MISSING: "CERT_MISSING", // 资质不满足
  CERT_EXPIRED: "CERT_EXPIRED", // 证照到期
  TEAM_SIZE: "TEAM_SIZE", // 人数不足
  WINDOW_UNCOVERED: "WINDOW_UNCOVERED", // 布/撤场窗口无法覆盖
  TEAM_DOUBLE_BOOKED: "TEAM_DOUBLE_BOOKED", // 同一时段重复占用
  TEAM_AWAY: "TEAM_AWAY", // 队伍临时离场/借调窗口，不可排班
  AED_RESPONSE: "AED_RESPONSE", // AED 响应时间超出规范
  AED_FAULT: "AED_FAULT", // 设备故障
  AED_UNAVAILABLE: "AED_UNAVAILABLE",
  VEHICLE_UNAVAILABLE: "VEHICLE_UNAVAILABLE",
  VEHICLE_STRETCHER: "VEHICLE_STRETCHER", // 老年活动需担架车
  ROUTE_CLOSED: "ROUTE_CLOSED", // 路线管制/封闭
  FACILITY_CAPABILITY: "FACILITY_CAPABILITY", // 医院能力不匹配
  FACILITY_CLOSED: "FACILITY_CLOSED", // 接诊窗口关闭
  OWNER_SCOPE: "OWNER_SCOPE", // 跨机构维护越权
  DUPLICATE_TASK: "DUPLICATE_TASK", // 重复通知试图生成第二份任务
  NO_BACKFILL: "NO_BACKFILL", // 抢占后无补位资源，缺口升级
  PHI_SCOPE: "PHI_SCOPE", // PHI 出现在非授权通道
  BAD_COMMAND: "BAD_COMMAND",
});

// 有权签署方案的角色
export const SIGNER_ROLES = Object.freeze(["SAFETY_DIRECTOR", "MEDICAL_AUTHORITY"]);

export function isEnum(value, list) {
  return list.includes(value);
}
