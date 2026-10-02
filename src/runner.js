// 场景回放：按 occurred_at 顺序应用一批命令，汇总每条命令的结果。
// 命令失败（如方案被驳回、重复通知）不会中断回放，而是记录到 results 供演练核对。

import { Store } from "./store.js";
import { Engine } from "./engine.js";

export function replay(commands, { store = new Store() } = {}) {
  const engine = new Engine(store);
  const ordered = [...commands].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const results = [];
  for (const cmd of ordered) {
    const r = engine.handle(cmd);
    results.push({
      command_id: cmd.command_id,
      kind: cmd.kind,
      occurred_at: cmd.occurred_at,
      ok: r.ok,
      replayed: r.replayed ?? false,
      duplicated: r.duplicated ?? false,
      rejected: r.rejected ?? false,
      event_ids: (r.events ?? []).map((e) => e.event_id),
      conflicts: r.conflicts ?? [],
    });
  }
  return { engine, store, results };
}
