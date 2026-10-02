// 突发事件响应解析（纯函数，无副作用）。
// 引擎用它落事件，演练端用同一份逻辑做“指定时刻 + 假设伤情”的只读推演。

import { riskRank } from "./domain.js";
import { MIN, overlap } from "./time.js";
import { aedLimit, certCovers } from "./norms.js";
import { pickChain, schedulePosts, teamEligible } from "./scheduler.js";

export const INCIDENT_HOLD_MIN = 60;

const CERT_BY_INJURY = {
  CARDIAC: "PARAMEDIC",
  TRAUMA: "EMT",
  PEDIATRIC: "FIRST_AID",
  SENIOR_FALL: "FIRST_AID",
  HEATSTROKE: "FIRST_AID",
};

export function certForInjury(injury) {
  return CERT_BY_INJURY[injury] ?? "FIRST_AID";
}

export function teamCoversAt(team, needCert, at) {
  if (!team) return false;
  const valid = (team.members ?? []).filter((m) => Date.parse(m.expires_at) >= at);
  const best = valid.reduce((acc, m) => (certCovers(m.cert, acc) ? m.cert : acc), "FIRST_AID");
  return valid.length > 0 && certCovers(best, needCert);
}

export function teamAwayAt(team, at) {
  return !!team && (team.away_windows ?? []).some((w) => overlap(at, at + 1, Date.parse(w[0]), Date.parse(w[1])));
}

export function aedReadyAt(aed, at) {
  return !!aed && aed.status === "ready" && !(aed.fault_windows ?? []).some((w) => overlap(at, at + 1, Date.parse(w[0]), Date.parse(w[1])));
}

export function inHeatAt(state, post, at) {
  return state.heatScopes.some(
    (h) =>
      (h.scope.post_ids?.includes(post.id) || h.scope.activity_ids?.includes(post.activity_id) || (h.scope.region && post.region === h.scope.region)) &&
      overlap(at, at + 1, h.window[0], h.window[1]),
  );
}

// 只能抢占 LOW 风险点位；已被突发事件占用的队伍不参与。
export function findTeamDonor(state, incidentPost, needCert, at) {
  const candidates = [];
  for (const [postId, asg] of state.assignments) {
    const p = state.postById.get(postId);
    if (!p || p.id === incidentPost.id || riskRank(p.risk) > riskRank("LOW")) continue;
    if (state.resourceEngaged.has(asg.team_id)) continue;
    const team = state.resources.get(asg.team_id);
    if (teamAwayAt(team, at)) continue;
    if (!teamCoversAt(team, needCert, at)) continue;
    const minutes = state.graph.minutes(p.ref, incidentPost.ref);
    if (Number.isFinite(minutes)) candidates.push({ team, post: p, minutes });
  }
  candidates.sort((a, b) => a.minutes - b.minutes);
  return candidates[0] ?? null;
}

export function findAed(state, post, norm, heat, at, exclude = []) {
  const limit = aedLimit(norm, heat);
  const candidates = [];
  for (const aed of state.resources.values()) {
    if (aed.kind !== "aed" || exclude.includes(aed.id) || state.resourceEngaged.has(aed.id)) continue;
    if (!aedReadyAt(aed, at)) continue;
    const minutes = state.graph.minutes(aed.ref, post.ref);
    if (!Number.isFinite(minutes) || minutes > limit) continue;
    const owner = [...state.assignments.entries()].find(([, a]) => a.aed_id === aed.id)?.[0] ?? null;
    if (owner) {
      const ownerPost = state.postById.get(owner);
      if (!ownerPost || riskRank(ownerPost.risk) > riskRank("LOW")) continue;
    }
    candidates.push({ aed, minutes, postId: owner });
  }
  candidates.sort((a, b) => a.minutes - b.minutes);
  return candidates[0] ?? null;
}

// 借调发生后，被掏空的低风险点位能否立刻补位（只读计算，不写事件）。
export function computeBackfill(state, donorPostId, borrowedId, at, norm) {
  const donorPost = state.postById.get(donorPostId);
  const current = state.assignments.get(donorPostId);
  const occupied = baseOccupied(state, new Set([donorPostId]));
  occupied.set(borrowedId, [...(occupied.get(borrowedId) ?? []), { s: at, e: at + INCIDENT_HOLD_MIN * MIN, post_id: "incident:drill" }]);
  // 只补被借走的槽位，另一槽位保持原资源
  const prefer =
    current && (current.team_id === borrowedId
      ? { aed_id: current.aed_id }
      : current.aed_id === borrowedId
        ? { team_id: current.team_id }
        : {});
  const result = schedulePosts([donorPost], {
    resources: state.resources,
    graph: state.graph,
    norm,
    occupied,
    preferSlots: new Map([[donorPostId, prefer]]),
    heatFor: (p) => inHeatAt(state, p, at),
  });
  return { replacement: result.assignments.get(donorPostId) ?? null, conflicts: result.conflicts };
}

export function baseOccupied(state, excludePostIds = new Set()) {
  const occupied = new Map();
  for (const [postId, asg] of state.assignments) {
    const p = state.postById.get(postId);
    if (!p || excludePostIds.has(postId)) continue;
    const w = { s: p.coverWindow.start, e: p.coverWindow.end, post_id: postId };
    occupied.set(asg.team_id, [...(occupied.get(asg.team_id) ?? []), w]);
    if (asg.aed_id) occupied.set(asg.aed_id, [...(occupied.get(asg.aed_id) ?? []), w]);
  }
  return occupied;
}

// 查找未被任何岗位占用、也未被突发事件锁定的空闲合格队伍。
export function findIdleTeam(state, post, needCert, at) {
  const busy = new Set();
  for (const asg of state.assignments.values()) busy.add(asg.team_id);
  const norm = state.normAt(at);
  const candidates = [];
  for (const tm of state.resources.values()) {
    if (tm.kind !== "team" || busy.has(tm.id) || state.resourceEngaged.has(tm.id)) continue;
    const el = teamEligible(tm, { post, norm, atStart: at, atEnd: at + 60 * MIN, resources: state.resources });
    if (!el.ok || !teamCoversAt(tm, needCert, at)) continue;
    candidates.push({ team: tm, minutes: state.graph.minutes(tm.ref, post.ref) });
  }
  candidates.sort((a, b) => a.minutes - b.minutes);
  return Number.isFinite(candidates[0]?.minutes) ? candidates[0] : null;
}

export function findIdleAed(state, post, norm, heat, at) {
  const assignedIds = new Set([...state.assignments.values()].map((a) => a.aed_id).filter(Boolean));
  const limit = aedLimit(norm, heat);
  const candidates = [];
  for (const aed of state.resources.values()) {
    if (aed.kind !== "aed" || assignedIds.has(aed.id) || state.resourceEngaged.has(aed.id)) continue;
    if (!aedReadyAt(aed, at)) continue;
    const minutes = state.graph.minutes(aed.ref, post.ref);
    if (Number.isFinite(minutes) && minutes <= limit) candidates.push({ aed, minutes });
  }
  candidates.sort((a, b) => a.minutes - b.minutes);
  return candidates[0] ?? null;
}

// 主入口：给定快照、点位与伤情，计算“哪支队、哪台 AED、哪条链路接手”。
// options.engagedVehicles / engagedResources：并发突发事件已锁定的资源。
export function resolveIncident(state, { post, injury, at, engagedVehicles = new Set() }) {
  const assigned = state.assignments.get(post.id) ?? null;
  const norm = state.normAt(at);
  const heat = inHeatAt(state, post, at);
  const decision = {
    post_id: post.id,
    injury,
    heat,
    norm_id: norm.norm_id,
    post_was_covered: !!assigned,
    team_id: assigned?.team_id ?? null,
    team_source_post_id: assigned ? post.id : null,
    team_preempted: false,
    aed_id: assigned?.aed_id ?? null,
    aed_source_post_id: assigned ? post.id : null,
    aed_preempted: false,
    chain: assigned?.chain ?? null,
    preempts: [],
    conflicts: [],
  };

  // 1) 救护队
  const needCert = certForInjury(injury);
  const ownTeam = decision.team_id ? state.resources.get(decision.team_id) : null;
  if (teamAwayAt(ownTeam, at) || !teamCoversAt(ownTeam, needCert, at)) {
    // 先找未被占用的空闲合格队（岗位缺口或本队资质不够时都适用）
    const idle = findIdleTeam(state, post, needCert, at);
    const donor = idle ? { team: idle.team, post: null, minutes: idle.minutes, idle: true } : findTeamDonor(state, post, needCert, at);
    if (donor) {
      decision.team_id = donor.team.id;
      decision.team_source_post_id = donor.post?.id ?? null;
      decision.team_eta_min = donor.minutes;
      if (donor.post) {
        // 抢占低风险点位：必须同步补位
        decision.team_preempted = true;
        const bf = computeBackfill(state, donor.post.id, donor.team.id, at, norm);
        decision.preempts.push({ kind: "team", resource_id: donor.team.id, donor_post_id: donor.post.id, eta_min: donor.minutes, ...bf });
        if (!bf.replacement) decision.conflicts.push({ code: "NO_BACKFILL", post_id: donor.post.id, resource: donor.team.id });
      }
    } else {
      decision.conflicts.push({ code: "CERT_MISSING", injury, need: needCert, detail: assigned ? "现场队先行处置，但无符合资质的可抢占队伍" : "该点位无在岗队且无空闲/可抢占的合格队伍" });
    }
  }

  // 2) AED
  if (!aedReadyAt(decision.aed_id ? state.resources.get(decision.aed_id) : null, at)) {
    const idleAed = findIdleAed(state, post, norm, heat, at);
    if (idleAed) {
      decision.aed_id = idleAed.aed.id;
      decision.aed_source_post_id = null;
      decision.aed_eta_min = idleAed.minutes;
    } else {
      const alt = findAed(state, post, norm, heat, at, assigned ? [assigned.aed_id] : []);
      if (alt) {
        decision.aed_id = alt.aed.id;
        decision.aed_source_post_id = alt.postId;
        decision.aed_eta_min = alt.minutes;
        decision.aed_preempted = alt.postId !== null && alt.postId !== post.id;
        if (decision.aed_preempted) {
          const bf = computeBackfill(state, alt.postId, alt.aed.id, at, norm);
          decision.preempts.push({ kind: "aed", resource_id: alt.aed.id, donor_post_id: alt.postId, eta_min: alt.minutes, ...bf });
          if (!bf.replacement) decision.conflicts.push({ code: "NO_BACKFILL", post_id: alt.postId, resource: alt.aed.id });
        }
      } else {
        decision.conflicts.push({ code: "AED_UNAVAILABLE", post_id: post.id, heat });
      }
    }
  }

  // 3) 转运链路（车辆待命池，按伤情/车型/路线/医院能力/ETA 即时锁定）
  const chainInfo = pickChain({
    post,
    injury,
    atStart: at,
    atEnd: at + 30 * MIN,
    norm,
    graph: state.graph,
    resources: state.resources,
    excludeVehicles: engagedVehicles,
  });
  if (chainInfo.chain) {
    decision.chain = {
      vehicle_id: chainInfo.chain.vehicle_id,
      route_id: chainInfo.chain.route_id,
      facility_id: chainInfo.chain.facility_id,
      eta_min: chainInfo.chain.eta_min,
    };
    decision.chain_limit_min = chainInfo.limit;
    decision.chain_candidates = chainInfo.candidates.length;
  } else {
    decision.chain = null;
    decision.conflicts.push({ code: "VEHICLE_UNAVAILABLE", injury, rejections: chainInfo.rejections.slice(0, 6) });
  }
  return decision;
}
