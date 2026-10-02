// 排班求解器（纯函数）：在给定资源状态下，为点位确定救护队、AED 与转运链路，
// 或返回带冲突码的解释。所有分钟数取整比较，输入均为毫秒时间戳。

import { CONFLICT_CODES, riskRank } from "./domain.js";
import { MIN, overlap } from "./time.js";
import { aedLimit, certCovers, certRank, etaLimit, requiredCert } from "./norms.js";

// ---- 位置图：Floyd–Warshall ----
export function buildGraph(links) {
  const nodes = new Set();
  for (const l of links) {
    nodes.add(l.a);
    nodes.add(l.b);
  }
  const dist = new Map();
  const d = (a, b) => (a === b ? 0 : dist.get(`${a}|${b}`) ?? Infinity);
  for (const l of links) {
    dist.set(`${l.a}|${l.b}`, Math.min(d(l.a, l.b), l.minutes));
    dist.set(`${l.b}|${l.a}`, Math.min(d(l.b, l.a), l.minutes));
  }
  for (const k of nodes)
    for (const i of nodes)
      for (const j of nodes) {
        const nd = d(i, k) + d(k, j);
        if (nd < d(i, j)) dist.set(`${i}|${j}`, nd);
      }
  return {
    nodes: [...nodes],
    minutes: (a, b) => d(a, b),
    routeMinutes(path) {
      let sum = 0;
      for (let i = 0; i < path.length - 1; i++) {
        const m = d(path[i], path[i + 1]);
        if (!Number.isFinite(m)) return Infinity;
        sum += m;
      }
      return sum;
    },
  };
}

const CAP_BY_INJURY = {
  CARDIAC: ["CARDIAC", "GREEN_CHANNEL"],
  PEDIATRIC: ["PEDIATRIC"],
  TRAUMA: ["TRAUMA"],
  SENIOR_FALL: ["STRETCHER_BAY"],
  HEATSTROKE: [],
};

const CERT_BY_INJURY = {
  CARDIAC: "PARAMEDIC",
  TRAUMA: "EMT",
  PEDIATRIC: "FIRST_AID",
  SENIOR_FALL: "FIRST_AID",
  HEATSTROKE: "FIRST_AID",
};

// 资源可用性判定。ctx: { at(时间戳), resources, occupied, norm, heatScope, graph }
export function teamEligible(team, { post, norm, atStart, atEnd, heat, resources }) {
  const reasons = [];
  const rule = norm.activity[post.activity_type];
  if (team.away_windows?.some((w) => overlap(atStart, atEnd, Date.parse(w[0]), Date.parse(w[1]))))
    reasons.push({ code: CONFLICT_CODES.TEAM_AWAY, team_id: team.id });
  const validMembers = (team.members ?? []).filter((m) => Date.parse(m.expires_at) >= atEnd);
  const leader = requiredCert(norm, post.activity_type, post.risk, post.requires?.cert);
  const best = validMembers.reduce((acc, m) => (certCovers(m.cert, acc) ? m.cert : acc), "FIRST_AID");
  if (!rule) reasons.push({ code: CONFLICT_CODES.BAD_COMMAND, detail: "未知活动类型" });
  if (validMembers.length < (rule?.min_team_size ?? 1))
    reasons.push({ code: CONFLICT_CODES.TEAM_SIZE, have: validMembers.length, need: rule?.min_team_size });
  if (!certCovers(best, leader)) reasons.push({ code: CONFLICT_CODES.CERT_MISSING, have: best, need: leader });
  return { ok: reasons.length === 0, reasons, leaderCert: leader, size: validMembers.length, bestCert: best };
}

export function aedEligible(aed, { post, graph, norm, heat, atStart, atEnd }) {
  const reasons = [];
  if (aed.status !== "ready" || aed.fault_windows?.some((w) => overlap(atStart, atEnd, Date.parse(w[0]), Date.parse(w[1]))))
    reasons.push({ code: CONFLICT_CODES.AED_FAULT, aed_id: aed.id });
  const minutes = graph.minutes(aed.ref, post.ref);
  const limit = aedLimit(norm, heat);
  if (!Number.isFinite(minutes)) reasons.push({ code: CONFLICT_CODES.AED_RESPONSE, minutes: null, limit });
  else if (minutes > limit) reasons.push({ code: CONFLICT_CODES.AED_RESPONSE, minutes, limit });
  return { ok: reasons.length === 0, reasons, minutes, limit: aedLimit(norm, heat) };
}

function routeOpen(route, s, e) {
  return !(route.closed_windows ?? []).some((w) => overlap(s, e, Date.parse(w[0]), Date.parse(w[1])));
}

// 选择转运链路：担架要求、路线开放且允许该伤情、医院能力与接诊窗口、ETA 达标。
export function pickChain({ post, injury, atStart, atEnd, norm, graph, resources, excludeVehicles = new Set(), excludeRoutes = new Set() }) {
  const candidates = [];
  const rejections = [];
  const needCaps = CAP_BY_INJURY[injury] ?? [];
  const needCert = CERT_BY_INJURY[injury] ?? "FIRST_AID";
  const stretcher = post?.requires?.stretcher || injury === "SENIOR_FALL";
  const limit = etaLimit(norm, injury);

  for (const v of resources.values()) {
    if (v.kind !== "vehicle" || excludeVehicles.has(v.id)) continue;
    if (stretcher && v.type !== "stretcher_ambulance") {
      rejections.push({ vehicle_id: v.id, code: CONFLICT_CODES.VEHICLE_STRETCHER });
      continue;
    }
    for (const r of resources.values()) {
      if (r.kind !== "route" || excludeRoutes.has(r.id)) continue;
      const head = r.path[0];
      const tail = r.path[r.path.length - 1];
      const fac = resources.get(tail);
      if (!fac || fac.kind !== "facility") continue;
      if (head !== post.ref) continue; // 路线起点必须是接人点位
      if (!routeOpen(r, atStart, atEnd)) {
        rejections.push({ route_id: r.id, code: CONFLICT_CODES.ROUTE_CLOSED });
        continue;
      }
      if (!(r.allowed_injuries ?? []).includes(injury)) continue;
      const vToPost = graph.minutes(v.ref, post.ref);
      const routeEta = graph.routeMinutes(r.path);
      if (!Number.isFinite(vToPost) || !Number.isFinite(routeEta)) continue;
      const eta = vToPost + routeEta;
      if (eta > limit) continue;
      const missing = needCaps.filter((c) => !(fac.capabilities ?? []).includes(c));
      if (missing.length) {
        rejections.push({ facility_id: fac.id, code: CONFLICT_CODES.FACILITY_CAPABILITY, missing });
        continue;
      }
      const fs = Date.parse(fac.window.start);
      const fe = Date.parse(fac.window.end);
      if (!overlap(atStart, atEnd + eta * MIN, fs, fe)) {
        rejections.push({ facility_id: fac.id, code: CONFLICT_CODES.FACILITY_CLOSED });
        continue;
      }
      candidates.push({ vehicle_id: v.id, route_id: r.id, facility_id: fac.id, eta_min: eta, vehicle_eta_min: vToPost, route_eta_min: routeEta, score: eta });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return { chain: candidates[0] ?? null, candidates, rejections, limit, needCert, stretcher };
}

// 为一批点位排班。posts 需携带 activity_type；occupied: Map(resourceId -> [{s,e,post_id}])
// preferSlots: Map(postId -> {team_id?, aed_id?}) —— 局部重排时优先保留仍合格的在岗资源，
// 只替换失效的那个槽位，避免一次通知把未受影响的队伍/设备也换掉。
export function schedulePosts(posts, ctx) {
  const { resources, graph, norm, heatFor, occupied: occupiedIn, lock = new Set(), preferSlots = new Map() } = ctx;
  const occupied = new Map();
  for (const [id, list] of occupiedIn) for (const w of list) occupied.set(id, [...(occupied.get(id) ?? []), w]);
  const isBusy = (id, s, e, exceptPost) =>
    (occupied.get(id) ?? []).some((w) => w.post_id !== exceptPost && overlap(s, e, w.s, w.e));

  const assignments = new Map();
  const conflicts = [];

  const ordered = [...posts].sort((a, b) => riskRank(b.risk) - riskRank(a.risk) || Date.parse(a.window.start) - Date.parse(b.window.start));
  for (const post of ordered) {
    const s = Date.parse(post.window.start);
    const e = Date.parse(post.window.end);
    const heat = heatFor?.(post) ?? false;
    const postConflicts = [];

    // 1) 救护队：局部重排优先保留在岗队；否则收集全部合格候选，
    //    优先“资质刚好达标”（不浪费高资质队），再按驻地距离取最近。
    let team = null;
    let teamReasons = null;
    const prefer = preferSlots.get(post.id) ?? {};
    // 方案可指定班组（如入口值守点由值班急救组驻守）；仍须合格且空闲。
    const designated = post.preferred_team_id ?? prefer.team_id ?? null;
    if (designated && !isBusy(designated, s, e, post.id)) {
      const pref = resources.get(designated);
      if (pref) {
        const el = teamEligible(pref, { post, norm, atStart: s, atEnd: e, heat, resources });
        if (el.ok) team = pref;
      }
    }
    if (!team) {
      const teamCandidates = [];
      for (const tm of resources.values()) {
        if (tm.kind !== "team" || isBusy(tm.id, s, e, post.id) || tm.id === designated) continue;
        const el = teamEligible(tm, { post, norm, atStart: s, atEnd: e, heat, resources });
        if (el.ok) teamCandidates.push({ tm, rank: certRank(el.bestCert), dist: graph.minutes(tm.ref, post.ref) });
        else teamReasons = el.reasons;
      }
      teamCandidates.sort((a, b) => a.rank - b.rank || (Number.isFinite(a.dist) ? a.dist : 999) - (Number.isFinite(b.dist) ? b.dist : 999));
      team = teamCandidates[0]?.tm ?? null;
    }
    if (!team) {
      postConflicts.push({ code: CONFLICT_CODES.CERT_MISSING, post_id: post.id, detail: "无符合资质且空闲的救护队", rejections: teamReasons });
    }

    // 2) AED（每台在重叠时段只保障一个点位；优先保留仍达标的在用机，其余按响应时间就近）
    let aed = null;
    let aedInfo = null;
    const aedRejections = [];
    const aedCandidates = [];
    const considerAed = (ad) => {
      if (isBusy(ad.id, s, e, post.id) || ad.id === prefer.aed_id) return;
      const el = aedEligible(ad, { post, graph, norm, heat, atStart: s, atEnd: e });
      if (el.ok) aedCandidates.push({ ad, el, minutes: el.minutes });
      else aedRejections.push({ aed_id: ad.id, ...el.reasons[0] });
    };
    if (prefer.aed_id && !isBusy(prefer.aed_id, s, e, post.id)) {
      const prefAed = resources.get(prefer.aed_id);
      if (prefAed) {
        const el = aedEligible(prefAed, { post, graph, norm, heat, atStart: s, atEnd: e });
        if (el.ok) {
          aed = prefAed;
          aedInfo = el;
        }
      }
    }
    if (!aed) {
      for (const ad of resources.values()) if (ad.kind === "aed") considerAed(ad);
      aedCandidates.sort((x, y) => x.minutes - y.minutes);
      aed = aedCandidates[0]?.ad ?? null;
      aedInfo = aedCandidates[0]?.el ?? null;
    }
    if (!aed) postConflicts.push({ code: CONFLICT_CODES.AED_UNAVAILABLE, post_id: post.id, heat, rejections: aedRejections.slice(0, 5) });

    // 3) 转运链路：MEDIUM 及以上点位在审批时必须有可行链路（车辆为待命池，事件时锁定）
    let chain = null;
    let chainInfo = null;
    if (riskRank(post.risk) >= riskRank("MEDIUM")) {
      chainInfo = pickChain({
        post,
        injury: post.injury_focus ?? "DEFAULT",
        atStart: s,
        atEnd: e,
        norm,
        graph,
        resources,
      });
      chain = chainInfo.chain;
      if (!chain)
        postConflicts.push({
          code: CONFLICT_CODES.VEHICLE_UNAVAILABLE,
          post_id: post.id,
          detail: "无满足车型/路线/医院能力/ETA 的转运链路",
          rejections: chainInfo.rejections.slice(0, 8),
        });
    }

    if (postConflicts.length) {
      conflicts.push(...postConflicts);
    } else {
      assignments.set(post.id, {
        post_id: post.id,
        team_id: team.id,
        aed_id: aed?.id ?? null,
        aed_response_min: aedInfo?.minutes ?? null,
        chain: chain ? { ...chain } : null,
        heat,
      });
      const hold = [{ s, e, post_id: post.id }];
      occupied.set(team.id, [...(occupied.get(team.id) ?? []), ...hold]);
      if (aed) occupied.set(aed.id, [...(occupied.get(aed.id) ?? []), ...hold]);
    }
  }
  return { assignments, conflicts, occupied };
}
