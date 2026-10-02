// 版本化规范（虚构，便于演练）。方案在其活动时段内必须完整落在同一版规范的有效期内。
// 新版规范生效后，仍引用旧版的方案在签署时会被判定 NORM_VERSION_MISMATCH。

export const NORMS = Object.freeze([
  {
    norm_id: "norm-2026-h1",
    label: "2026 年上半年群众赛事医疗保障规范（虚构）",
    effective_from: "2026-01-01T00:00:00+08:00",
    effective_to: "2026-09-01T00:00:00+08:00",
    setup_buffer_min: 30,
    teardown_buffer_min: 30,
    aed_response_min: 5,
    heat_aed_response_min: 4,
    max_eta_min: { CARDIAC: 15, PEDIATRIC: 20, TRAUMA: 20, SENIOR_FALL: 20, DEFAULT: 20 },
    activity: {
      road_run: { lead_cert: "EMT", critical_cert: "PARAMEDIC", min_team_size: 2, aed: true, caps: ["CARDIAC", "GREEN_CHANNEL"] },
      youth_ball: { lead_cert: "FIRST_AID", min_team_size: 2, aed: true, caps: ["PEDIATRIC"] },
      senior_walk: { lead_cert: "FIRST_AID", min_team_size: 2, aed: true, caps: ["STRETCHER_BAY"] },
    },
  },
  {
    norm_id: "norm-2026-h2",
    label: "2026 年下半年群众赛事医疗保障规范（虚构）",
    effective_from: "2026-09-01T00:00:00+08:00",
    effective_to: null,
    setup_buffer_min: 40, // 布场前置覆盖由 30 分钟收紧到 40 分钟
    teardown_buffer_min: 40,
    aed_response_min: 4, // AED 响应由 5 分钟收紧到 4 分钟
    heat_aed_response_min: 3, // 高温预警下再收紧到 3 分钟
    max_eta_min: { CARDIAC: 15, PEDIATRIC: 20, TRAUMA: 20, SENIOR_FALL: 20, DEFAULT: 20 },
    activity: {
      road_run: { lead_cert: "EMT", critical_cert: "PARAMEDIC", min_team_size: 2, aed: true, caps: ["CARDIAC", "GREEN_CHANNEL"] },
      youth_ball: { lead_cert: "FIRST_AID", min_team_size: 2, aed: true, caps: ["PEDIATRIC"] },
      senior_walk: { lead_cert: "FIRST_AID", min_team_size: 2, aed: true, caps: ["STRETCHER_BAY", "CARDIAC"] },
    },
  },
]);

const CERT_RANK = { FIRST_AID: 1, EMT: 2, PARAMEDIC: 3, PHYSICIAN: 4 };
export const certRank = (c) => CERT_RANK[c] ?? 0;

export function normAt(ms) {
  return (
    NORMS.find((n) => {
      const from = Date.parse(n.effective_from);
      const to = n.effective_to ? Date.parse(n.effective_to) : Infinity;
      return ms >= from && ms < to;
    }) || null
  );
}

// 活动窗口必须完整落在同一版规范内，否则返回 null（方案无法适用单一规范）。
export function normForWindow(startMs, endMs) {
  const n = normAt(startMs);
  if (!n) return null;
  const to = n.effective_to ? Date.parse(n.effective_to) : Infinity;
  return endMs <= to ? n : null;
}

export function requiredCert(norm, activityType, risk, explicit) {
  if (explicit) return explicit;
  const rule = norm.activity[activityType];
  if (!rule) return null;
  return risk === "HIGH" || risk === "CRITICAL" ? rule.critical_cert || rule.lead_cert : rule.lead_cert;
}

export function certCovers(held, required) {
  return CERT_RANK[held] >= CERT_RANK[required];
}

export function aedLimit(norm, heatActive) {
  return heatActive ? norm.heat_aed_response_min : norm.aed_response_min;
}

export function etaLimit(norm, injury) {
  return norm.max_eta_min[injury] ?? norm.max_eta_min.DEFAULT;
}
