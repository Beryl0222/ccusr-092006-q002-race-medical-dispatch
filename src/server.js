// 独立运行的 HTTP 编排服务（零外部依赖，仅用 node:http）。
// 运维通道（命令、管理/演练视图）与 PHI 分区物理分离：本服务不提供 PHI 读取接口，
// PHI 仅落盘于独立文件，由接诊医院的授权通道另行访问。

import http from "node:http";
import { URL } from "node:url";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { adminView, drillView, publicView } from "./views.js";

export function createServer({ store = new Store() } = {}) {
  const engine = new Engine(store);

  const json = (res, status, body) => {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(text);
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
        if (data.length > 2_000_000) reject(new Error("请求体过大"));
      });
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (err) {
          reject(err);
        }
      });
    });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true, events: store.events.length, phi_events: store.phiEvents.length });

      // 演练人员：指定时刻 + 点位 + 假设伤情
      if (req.method === "GET" && path === "/views/drill") {
        const q = url.searchParams;
        const view = drillView(engine, { at: q.get("at"), post_id: q.get("post_id"), injury: q.get("injury") });
        return json(res, view.ok ? 200 : 409, view);
      }

      // 管理端：冲突与每次调整
      if (req.method === "GET" && path === "/views/admin") {
        const asOf = url.searchParams.get("asOf") ? Date.parse(url.searchParams.get("asOf")) : Date.now();
        return json(res, 200, adminView(engine, { asOf }));
      }

      // 公开赛事视图（不含 PHI、不含内部人员/证照信息）
      if (req.method === "GET" && path === "/views/public") {
        const asOf = url.searchParams.get("asOf") ? Date.parse(url.searchParams.get("asOf")) : Date.now();
        return json(res, 200, publicView(engine, { asOf }));
      }

      // 事件审计流（仅运维分区）
      if (req.method === "GET" && path === "/events") {
        const asOf = url.searchParams.get("asOf") ? Date.parse(url.searchParams.get("asOf")) : Infinity;
        return json(res, 200, { events: store.read({ asOf }) });
      }

      // 单条命令（资源维护、通知、提交/签署、突发伤情、交接、PHI 写入）
      if (req.method === "POST" && path === "/commands") {
        const cmd = await readBody(req);
        const result = engine.handle(cmd);
        return json(res, result.ok ? 200 : 409, result);
      }

      // 批量回放（演练脚本）
      if (req.method === "POST" && path === "/replay") {
        const body = await readBody(req);
        const commands = body.commands ?? [];
        const ordered = [...commands].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
        const results = ordered.map((cmd) => {
          const r = engine.handle(cmd);
          return {
            command_id: cmd.command_id,
            kind: cmd.kind,
            ok: r.ok,
            replayed: r.replayed ?? false,
            duplicated: r.duplicated ?? false,
            rejected: r.rejected ?? false,
            event_ids: (r.events ?? []).map((e) => e.event_id),
            conflicts: r.conflicts ?? [],
          };
        });
        return json(res, 200, { results });
      }

      if (path.startsWith("/phi")) return json(res, 403, { error: "PHI 分区不由公开编排接口提供；请走接诊医院授权通道读取独立存储。" });
      return json(res, 404, { error: "not_found", path });
    } catch (err) {
      return json(res, 400, { error: "bad_request", detail: String(err.message ?? err) });
    }
  });

  return { server, engine, store };
}

export function listen(port = 8080) {
  const { server } = createServer();
  server.listen(port, () => {
    console.log(`编排服务已启动: http://localhost:${port}`);
    console.log("  GET  /views/drill?at=&post_id=&injury=");
    console.log("  GET  /views/admin?asOf=");
    console.log("  GET  /views/public?asOf=");
    console.log("  POST /commands   POST /replay   GET /events");
  });
  return server;
}
