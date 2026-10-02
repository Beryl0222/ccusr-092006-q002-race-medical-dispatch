// 群众赛事医疗资源编排：领域模型、时间/几何工具与版本化规范判定。
// 资料按四方分别维护：主办方 organizer、医院 hospital、急救站 ems_station、志愿团队 volunteer。

export const PARTIES = Object.freeze({
  ORGANIZER: "organizer",
  EMS_STATION: "ems_station",
  HOSPITAL: "hospital",
  VOLUNTEER: "volunteer",
});

export const RISK_LEVELS = Object.freeze(["low", "medium", "high"]);
const RISK_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });

// 参赛人群 → 交接医院必须具备的能力
export const GROUP_CAPABILITIES = Object.freeze({
  road_run: ["cardiac", "trauma"],
  youth_ball: ["pediatric", "trauma"],
  elderly_walk: ["geriatric", "cardiac"],
});

// 资质等级，数字越大能力越强
const QUAL_RANK = Object.freeze({ first_aid: 1, first_aid_cert: 2, emt: 3 });

// ---------- 时间 ----------

export function t(iso) {
  return Date.parse(iso);
}

export function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function slotStart(atMs, slotMinutes) {
  return Math.floor(atMs / (slotMinutes * 60000)) * slotMinutes * 60000;
}

export function* iterSlots(startMs, endMs, slotMinutes) {
  for (let s = slotStart(startMs, slotMinutes); s < endMs; s += slotMinutes * 60000) {
    if (s + slotMinutes * 60000 <= startMs) continue;
    yield s;
  }
}

// ---------- 规范（按生效日期版本化） ----------

// 取事件发生时刻有效的规范版本；effective_to 为 null 表示至今有效。
export function activeRegulationAt(regulations, atIso) {
  const at = typeof atIso === "number" ? atIso : t(atIso);
  const hit = regulations
    .filter((r) => t(r.effective_from) <= at && (r.effective_to == null || at < t(r.effective_to)))
    .sort((a, b) => t(b.effective_from) - t(a.effective_from))[0];
  return hit ?? null;
}

// ---------- 人员资质 / 设备合格判定 ----------

export function credentialValid(cred, atIso) {
  const at = typeof atIso === "number" ? atIso : t(atIso);
  return t(cred.issued) <= at && at < t(cred.expires);
}

// 队伍在指定时刻是否满足最低资质，且所有证照都在有效期内。
export function teamQualifies(team, requiredLevel, atIso) {
  const need = QUAL_RANK[requiredLevel] ?? 1;
  const have = QUAL_RANK[team.qual_level] ?? 0;
  if (have < need) return false;
  return (team.credentials ?? []).every((c) => credentialValid(c, atIso));
}

export function deviceReady(device, atIso) {
  const at = typeof atIso === "number" ? atIso : t(atIso);
  return (
    device.kind === "AED" &&
    device.status === "ready" &&
    t(device.battery_expires) > at &&
    t(device.pad_expires) > at
  );
}

// ---------- 几何 / 路程 ----------

export function km(a, b) {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLng = ((b[0] - a[0]) * Math.PI) / 180;
  const la1 = (a[1] * Math.PI) / 180;
  const la2 = (b[1] * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function etaMinutes(from, to, speedKmh) {
  return Math.ceil((km(from, to) / speedKmh) * 60);
}

// ---------- 脱敏：赛事公开视图不得出现真实个人健康资料 ----------

const MASKED_KEYS = new Set([
  "id_number",
  "phone",
  "birth_date",
  "conditions",
  "emergency_contact",
  "medications",
  "health_note",
]);

// 公开视图：保留岗位所需的资质等级与证照有效期状态，隐去证号、联系方式与任何健康字段。
export function publicView(value) {
  if (Array.isArray(value)) return value.map(publicView);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (MASKED_KEYS.has(k)) {
        out[k] = k === "conditions" || k === "medications" ? [] : "***";
        continue;
      }
      if (k === "credential_number") {
        out[k] = "***";
        continue;
      }
      out[k] = publicView(v);
    }
    return out;
  }
  return value;
}

// 受限健康库：与赛事数据物理分文件存放，任何读取都要授权并留痕。
export class HealthVault {
  constructor(records = []) {
    this._records = records;
    this.accessLog = [];
  }

  read(atIso, role, scopes = []) {
    const allowed = role === "medical_officer" && scopes.includes("phi");
    this.accessLog.push({ at: atIso, role, granted: allowed });
    if (!allowed) {
      const err = new Error("健康资料访问被拒绝：需要 medical_officer 身份与 phi 授权范围");
      err.code = "PHI_DENIED";
      throw err;
    }
    return this._records;
  }

  // 用于隔离测试：健康库中出现过的任何真实字段值都不得出现在公开视图里。
  sensitiveTokens() {
    const tokens = [];
    for (const r of this._records) {
      for (const c of r.conditions ?? []) tokens.push(c);
      for (const m of r.medications ?? []) tokens.push(m);
      if (emergencyName(r)) tokens.push(emergencyName(r));
    }
    return tokens.filter(Boolean);
  }
}

function emergencyName(r) {
  return r.emergency_contact?.name;
}
