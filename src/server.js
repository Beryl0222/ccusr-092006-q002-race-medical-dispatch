// 可独立运行的编排 HTTP 服务（仅用 node:http，零依赖）。
// 启动：node src/server.js [--port 8088] [--snapshot data/weekend_scenario.json] [--health data/restricted_health_vault.json]
//
// 路由：
//   POST /plans                    {at, signer_id}                    签署生效（有冲突返回 409 与冲突清单）
//   GET  /plans                                                          当前生效方案元数据
//   GET  /conflicts?at=iso                                               管理端：冲突解释
//   GET  /response?at=iso&position=ID                                    演练：某时刻某点位的接手方
//   POST /response/batch          {at, positions:[...]}                 多点位同时伤情
//   POST /adjustments/heat        {at, operator, window, position_ids}
//   POST /adjustments/device      {at, operator, device_id}
//   POST /adjustments/credential  {at, operator, team_id}
//   POST /adjustments/corridor    {at, operator, corridor_id, status}
//   POST /adjustments/window      {at, operator, position_id, window}
//   POST /incidents               {at, operator, ephemeral|position_id, window_minutes}
//   POST /notifications           {fingerprint, ...}                    重复通知幂等
//   GET  /tasks                                                          任务清单
//   GET  /adjustments                                                   调整审计
//   GET  /adjustments/:id                                               单次调整解释
//   GET  /public-state                                                  脱敏后的公开赛事视图
//   POST /health-records         {role, scopes:[]}                      受限健康库（需 medical_officer + phi）

import { readFile } from "node:fs/promises";
import http from "node:http";
import { HealthVault } from "./domain.js";
import { Orchestrator } from "./orchestrator.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const port = Number(arg("port", "8088"));
  const snapshotPath = arg("snapshot", new URL("../data/weekend_scenario.json", import.meta.url));
  const healthPath = arg("health", new URL("../data/restricted_health_vault.json", import.meta.url));

  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  let vault = null;
  try {
    const health = JSON.parse(await readFile(healthPath, "utf8"));
    vault = new HealthVault(health.records);
  } catch {
    // 健康库是独立挂载的；文件缺失时服务仍可运行，只是不提供受限读取。
  }

  const orchestrator = new Orchestrator({
    snapshot,
    healthVault: vault,
    signers: snapshot.signers,
    clock: () => new Date().toISOString(),
  });

  const server = http.createServer((req, res) => handle(req, res, orchestrator).catch((e) => sendError(res, e)));
  server.listen(port, () => {
    console.log(`赛事医疗资源编排服务已启动：http://localhost:${port}`);
    console.log("先 POST /plans 由安全负责人签署，再 GET /response?at=...&position=... 演练。");
  });
}

async function handle(req, res, orchestrator) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;
  const method = req.method;
  const body = method === "POST" ? await readJson(req) : {};

  // 签署
  if (method === "POST" && path === "/plans") {
    const result = orchestrator.approvePlan({ at: body.at, signer_id: body.signer_id, plan_id: body.plan_id });
    return send(res, 201, result);
  }
  if (method === "GET" && path === "/plans") {
    if (!orchestrator.plan) return send(res, 404, { error: "尚无生效方案", code: "PLAN_NOT_EFFECTIVE" });
    return send(res, 200, {
      plan_id: orchestrator.plan.plan_id,
      signed_at: orchestrator.plan.signed_at,
      signer: orchestrator.plan.signer,
      signature: orchestrator.plan.signature,
      manifest: orchestrator.plan.manifest,
    });
  }

  // 演练查询
  if (method === "GET" && path === "/response") {
    return send(res, 200, orchestrator.responseAt(url.searchParams.get("at"), url.searchParams.get("position")));
  }
  if (method === "POST" && path === "/response/batch") {
    return send(res, 200, { results: orchestrator.responseAtMany(body.at, body.positions ?? []) });
  }

  // 管理端解释
  if (method === "GET" && path === "/conflicts") {
    return send(res, 200, { conflicts: orchestrator.explainConflicts(url.searchParams.get("at")) });
  }
  if (method === "GET" && path === "/adjustments") {
    return send(res, 200, { adjustments: orchestrator.auditLog() });
  }
  if (method === "GET" && path.startsWith("/adjustments/")) {
    return send(res, 200, orchestrator.explainAdjustment(path.split("/").pop()));
  }
  if (method === "GET" && path === "/tasks") {
    return send(res, 200, { tasks: orchestrator.listTasks() });
  }

  // 局部重排
  const reroutes = {
    "/adjustments/heat": (b) => orchestrator.applyHeatWarning(b),
    "/adjustments/device": (b) => orchestrator.reportDeviceFailure(b),
    "/adjustments/credential": (b) => orchestrator.reportCredentialExpiry(b),
    "/adjustments/corridor": (b) => orchestrator.rerouteCorridor(b),
    "/adjustments/window": (b) => orchestrator.changePositionWindow(b),
  };
  if (method === "POST" && reroutes[path]) return send(res, 200, reroutes[path](body));

  // 突发事件
  if (method === "POST" && path === "/incidents") {
    return send(res, 201, orchestrator.declareIncident(body));
  }

  // 通知幂等
  if (method === "POST" && path === "/notifications") return send(res, 200, orchestrator.notify(body));

  // 公开视图与受限健康库
  if (method === "GET" && path === "/public-state") return send(res, 200, orchestrator.publicState());
  if (method === "POST" && path === "/health-records") {
    return send(res, 200, { records: orchestrator.readHealthRecords({ role: body.role, scopes: body.scopes ?? [] }) });
  }

  send(res, 404, { error: `未找到路由 ${method} ${path}` });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function send(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

function sendError(res, err) {
  const statusByCode = {
    SIGNER_UNAUTHORIZED: 403,
    PLAN_NOT_EFFECTIVE: 409,
    PLAN_HAS_CONFLICTS: 409,
    PHI_DENIED: 403,
    NO_HEALTH_VAULT: 404,
    NOT_FOUND: 404,
  };
  const status = statusByCode[err.code] ?? 400;
  send(res, status, { error: err.message, code: err.code ?? "BAD_REQUEST", conflicts: err.conflicts });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
