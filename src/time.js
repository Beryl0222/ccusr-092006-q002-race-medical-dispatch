// 时间工具：统一用毫秒时间戳在内部计算，输入/输出用带时区的 ISO 字符串。

export function t(iso) {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`非法时间: ${iso}`);
  return ms;
}

export const iso = (ms) => new Date(ms).toISOString();
export const MIN = 60_000;

// 半开区间 [start, end)
export function overlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

export function contains(outerS, outerE, innerS, innerE) {
  return outerS <= innerS && innerE <= outerE;
}

export function clampWindow(start, end, s, e) {
  // 返回 [start,end) 与 [s,e) 的交集，无交集返回 null
  const cs = Math.max(start, s);
  const ce = Math.min(end, e);
  return cs < ce ? [cs, ce] : null;
}

export function fmtMin(ms) {
  return `${Math.round(ms / MIN)} 分钟`;
}
