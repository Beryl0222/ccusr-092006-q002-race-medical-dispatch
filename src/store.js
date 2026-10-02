// 追加式事件存储。
// - 运维事件与 PHI（个人健康资料）物理分区分流，公开视图永不读取 PHI 分区。
// - command_id 幂等：同一命令重放，返回首次产生的事件，不产生第二份任务。
// - notice_id 去重：同一通知重复送达，只记录 NOTICE_SUPPRESSED 审计事件，不再触发调整。

import { EVENT_KINDS } from "./domain.js";

export class Store {
  constructor() {
    this.events = []; // 运维事件流
    this.phiEvents = []; // PHI 独立分区
    this.#rebuildIndexes();
  }

  #ids = new Set();
  #byCommand = new Map();
  #byNotice = new Map();

  #rebuildIndexes() {
    for (const e of this.events) {
      this.#ids.add(e.event_id);
      if (e.payload?.command_id) {
        const list = this.#byCommand.get(e.payload.command_id) ?? [];
        list.push(e.event_id);
        this.#byCommand.set(e.payload.command_id, list);
      }
      if (e.payload?.notice_id) this.#byNotice.set(e.payload.notice_id, e.event_id);
    }
  }

  append(event, { partition = "main" } = {}) {
    if (!event.event_id) throw new Error("事件缺少 event_id");
    if (this.#ids.has(event.event_id)) throw new Error(`事件重复: ${event.event_id}`);
    if (partition === "phi") {
      this.phiEvents.push(event);
      this.#ids.add(event.event_id);
      return event;
    }
    if (!EVENT_KINDS.includes(event.kind)) throw new Error(`未知事件类型: ${event.kind}`);
    event.seq = this.events.length + 1;
    this.events.push(event);
    this.#ids.add(event.event_id);
    if (event.payload?.command_id) {
      const list = this.#byCommand.get(event.payload.command_id) ?? [];
      list.push(event.event_id);
      this.#byCommand.set(event.payload.command_id, list);
    }
    if (event.payload?.notice_id && event.kind !== "NOTICE_SUPPRESSED") {
      this.#byNotice.set(event.payload.notice_id, event.event_id);
    }
    return event;
  }

  // 已处理过的命令（幂等重放）
  commandSeen(commandId) {
    const ids = this.#byCommand.get(commandId);
    if (!ids) return null;
    return this.events.filter((e) => ids.includes(e.event_id));
  }

  // 已处理过的通知（重复通知判定）。返回首次处理事件。
  noticeHandled(noticeId) {
    const id = this.#byNotice.get(noticeId);
    return id ? this.events.find((e) => e.event_id === id) : null;
  }

  // 读取运维事件流；asOf 用于“按指定时刻”回放。
  read({ asOf = Infinity, kinds = null } = {}) {
    return this.events.filter((e) => {
      if (Date.parse(e.occurred_at) > asOf) return false;
      if (kinds && !kinds.includes(e.kind)) return false;
      return true;
    });
  }

  // 读取 PHI 必须显式声明分区——任何公开投影都不会调用它。
  readPhi({ asOf = Infinity } = {}) {
    return this.phiEvents.filter((e) => Date.parse(e.occurred_at) <= asOf);
  }

  // JSONL 持久化：两条流分文件存放，PHI 文件仅授权通道访问。
  async save(fs, dir) {
    const lines = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await fs.mkdir(`${dir}/phi`, { recursive: true });
    await fs.writeFile(`${dir}/events.jsonl`, lines(this.events), "utf8");
    await fs.writeFile(`${dir}/phi/phi.jsonl`, lines(this.phiEvents), "utf8");
  }

  static async load(fs, dir) {
    const store = new Store();
    const loadFile = async (path, partition) => {
      try {
        const text = await fs.readFile(path, "utf8");
        for (const line of text.split("\n").filter(Boolean)) {
          const event = JSON.parse(line);
          delete event.seq;
          store.append(event, partition === "phi" ? { partition: "phi" } : undefined);
        }
      } catch (err) {
        if (err.code !== "ENOENT") throw err;
      }
    };
    await loadFile(`${dir}/events.jsonl`, "main");
    await loadFile(`${dir}/phi/phi.jsonl`, "phi");
    return store;
  }
}
