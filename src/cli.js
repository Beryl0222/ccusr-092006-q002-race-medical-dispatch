// 命令行：演练人员 / 管理端的本地入口。
//
//   node src/cli.js replay  data/scenario.json                 回放整段周末演练，打印每条命令结果
//   node src/cli.js drill   data/scenario.json --at <ISO> --post <id> --injury <CARDIAC|...>
//   node src/cli.js admin   data/scenario.json [--asOf <ISO>]  打印资源冲突与每次调整
//   node src/cli.js public  data/scenario.json [--asOf <ISO>] 打印公开赛事视图（验证无 PHI）
//   node src/cli.js serve   [--port 8080] [--scenario data/scenario.json]

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { replay } from "./runner.js";
import { adminView, drillView, publicView } from "./views.js";
import { listen, createServer } from "./server.js";

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args.flags[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    else args._.push(a);
  }
  return args;
}

async function loadScenario(path) {
  const doc = JSON.parse(await readFile(resolve(process.cwd(), path), "utf8"));
  return Array.isArray(doc) ? doc : doc.commands;
}

const out = (v) => console.log(JSON.stringify(v, null, 2));

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const { _: positional, flags } = parseArgs(argv.slice(1));
  const file = positional[0];

  if (mode === "serve") {
    const port = Number(flags.port ?? process.env.PORT ?? 8080);
    if (flags.scenario) {
      const { server, engine } = createServer();
      const commands = await loadScenario(flags.scenario);
      for (const cmd of [...commands].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))) engine.handle(cmd);
      server.listen(port, () => console.log(`编排服务（已载入场景 ${flags.scenario}）: http://localhost:${port}`));
    } else {
      listen(port);
    }
    return;
  }

  if (!file) throw new Error("缺少场景文件");
  const commands = await loadScenario(file);
  const { engine, results } = replay(commands);

  if (mode === "replay") {
    const failed = results.filter((r) => !r.ok);
    out({
      total: results.length,
      succeeded: results.length - failed.length,
      failed: failed.length,
      results,
    });
    if (flags.admin !== undefined) out(adminView(engine));
    if (failed.length && flags["fail-on-conflict"]) process.exitCode = 1;
    return;
  }

  if (mode === "drill") {
    if (!flags.at || !flags.post || !flags.injury) throw new Error("drill 需要 --at <ISO> --post <点位ID> --injury <伤情>");
    out(drillView(engine, { at: flags.at, post_id: flags.post, injury: flags.injury }));
    return;
  }

  if (mode === "admin") {
    out(adminView(engine, { asOf: flags.asOf ? Date.parse(flags.asOf) : Date.now() }));
    return;
  }

  if (mode === "public") {
    out(publicView(engine, { asOf: flags.asOf ? Date.parse(flags.asOf) : Date.now() }));
    return;
  }

  console.error("未知模式：", mode);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(String(err.stack ?? err));
  process.exitCode = 1;
});
