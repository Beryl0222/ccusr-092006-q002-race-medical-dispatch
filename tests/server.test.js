// HTTP 服务集成测试（随机端口，零外部依赖）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createServer } from "../src/server.js";

async function loadScenario() {
  const doc = JSON.parse(await readFile(new URL("../data/scenario.json", import.meta.url), "utf8"));
  return doc.commands;
}

async function withServer(commands) {
  const { server } = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  const api = async (path, init) => {
    const res = await fetch(base + path, init);
    const body = await res.json();
    return { status: res.status, body };
  };
  for (const cmd of [...commands].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at)))
    await api("/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cmd) });
  return { api, close: () => new Promise((r) => server.close(r)) };
}

test("HTTP：演练 / 管理 / 公开三视图与 PHI 隔离、命令幂等", async (t) => {
  const commands = await loadScenario();
  const { api, close } = await withServer(commands);
  t.after(close);

  const drill = await api("/views/drill?at=2026-10-10T09:59:00%2B08:00&post_id=P_RUN_5K&injury=CARDIAC");
  assert.equal(drill.status, 200);
  assert.equal(drill.body.responder.team.id, "T_PARAM");
  assert.equal(drill.body.handoff.facility.id, "H_MAIN");

  const admin = await api("/views/admin?asOf=2026-10-10T10:25:00%2B08:00");
  assert.ok(admin.body.adjustments.some((a) => a.reason === "EMERGENCY_PREEMPT"));
  // 每条冲突都带中文解释
  const explained = admin.body.plans.flatMap((p) => p.conflicts);
  assert.ok(explained.every((c) => typeof c.explanation === "string"));

  const pub = await api("/views/public?asOf=2026-10-10T10:05:00%2B08:00");
  assert.equal(pub.body.phi_included, false);
  assert.ok(!JSON.stringify(pub.body).includes("髋部骨折"));

  const phi = await api("/phi/anything");
  assert.equal(phi.status, 403);

  const events = await api("/events");
  assert.ok(events.body.events.every((e) => e.kind !== "PHI_RECORDED"));

  // 幂等：重放同一 command_id 不新增事件
  const count = events.body.events.length;
  const again = await api("/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command_id: "cmd-inc-run-1000",
      kind: "report_incident",
      occurred_at: "2026-10-10T10:00:00+08:00",
      incident: { incident_id: "INC-1001", post_id: "P_RUN_5K", injury: "CARDIAC", severity: "CRITICAL" },
    }),
  });
  assert.equal(again.body.replayed, true);
  const events2 = await api("/events");
  assert.equal(events2.body.events.length, count);
});
