# 群众赛事医疗资源编排服务

赛事安全负责人批准周末活动前必须能回答一个具体问题：**路跑、青少年球赛、老年健步若同时出现伤情，哪支救护队、哪台 AED、哪条转运路线立即接手，而不是等现场打电话抢资源。**

本服务把答案从事后争抢变为**签署前就逐时间槽确定的预指派**，并在高温、证照到期、设备故障、路线改变和突发事件下只重排受影响岗位；所有资料由四方分别维护，方案只有符合当时规范且经有权人员签署才生效；真实个人健康资料隔离在公开赛事视图之外。

全部为零依赖 Node.js（`node:http` / `node:test`）实现，可独立运行，资料全部虚构。

## 它如何回答那个问题

签署生效后，调度引擎按 10 分钟时间槽对每个在岗点位确定性地选出：

- **救护队**：资质等级满足该风险等级在**当时有效规范**下的要求、证照在有效期内、响应时间达标（主责 + 一支备援）；
- **AED**：自检就绪、电池/电极片未过期、在规范限定距离内；
- **转运路线 + 接收医院**：医院具备该参赛人群所需能力（路跑 cardiac+trauma、青少年 pediatric+trauma、老年 geriatric+cardiac），通道开放且急诊窗口开放；首选通道封闭时自动改走通往另一家合格医院的备用通道；
- **车辆**：按规范风险等级预置（低风险点位不强制），到场 + 通道耗时满足交接时限。

高风险点位在每个槽位优先挑选资源，同一资源不会被两个点位同时占用；选不出时给出**带原因码的冲突**（无合格队伍 / 全部在忙 / 距离超限 / 无就绪 AED / 无开放通道 / 无能力医院 / 无可达车辆）。

## 四方分别维护的资料

| 维护方 | 资料 |
| --- | --- |
| 主办方 organizer | 路线时段、布撤场窗口、参赛人群与人数、补给点、风险评估、点位、部分 AED/接驳车、签署人 |
| 急救站 ems_station | 车组与资质授权、站内 AED、救护车、转运通道 |
| 医院 hospital | 急诊窗口、能力标签、绿色通道交接能力 |
| 志愿团队 volunteer | 志愿救援队与救护员证、驻点 AED |

快照中带 `data_versions`（四方各一个版本号），规范库 `regulations` 按 `effective_from/effective_to` 版本化（场景含 QSM-2024-C 已失效、QSM-2026-B 现行两版）。签署摘要对数据版本、规范版本与全部覆盖项取 SHA-256，任何一方改资料都会改变签名。

## 生效与变更规则

- **签署门槛**：无冲突 + 适用当时规范 + 签署人持有 `medical_plan` 权限且授权在有效期内，三者同时满足方案才生效（场景中统筹 `S_HE` 无医疗签署权、前任负责人 `S_RET` 授权已过期，均被拒）。
- **高温预警 / 证照到期 / 设备故障 / 路线改变 / 时段改变**：只解锁受影响岗位（谁在用被撤资源 + 试排后谁换了资源的并集），其余岗位以锁定指派占住资源，连锁变化无法越过锁定边界。
- **突发事件**：按高风险处理，事件窗内**同为高风险的岗位锁定不被抢**，中低风险点位可被抢占；每个被抢占的原任务同步生成
  - 补位记录（被抢字段、新接手方、`backfilled` / `open`），
  - 升级记录（通知医疗官；补不齐时额外通知互助协调员）。
- **通知幂等**：任务以指纹去重，重复通知、同一调整重复同步都不会生成第二份任务；未变动岗位不发新任务。
- **审计**：每次调整记录原因、操作人、逐字段差异（from→to）、影响岗位与遗留冲突，管理端可逐条解释。
- **健康隔离**：`data/restricted_health_vault.json` 与赛事数据物理分文件；公开视图脱敏（证号、联系方式、病史、用药等），只有 `medical_officer` + `phi` 授权能读受限库且每次读取（含拒绝）留痕。

## 目录

```
src/domain.js        领域模型：规范版本、资质/证照、AED 就绪、路程、脱敏、健康库
src/scheduler.js     纯函数调度引擎：逐槽位预指派 + 冲突原因 + 锁定/覆盖层
src/orchestrator.js  编排核心：签署、查询、局部重排、抢占补位、幂等任务、审计
src/server.js        零依赖 HTTP 服务
src/drill.js         分时刻演练脚本
data/weekend_scenario.json        2026-10-04 三场同发虚构场景（四方资料）
data/restricted_health_vault.json 受限健康库（独立文件，勿入公开视图）
data/sample.json     原有领域事件样例
tests/               domain / scheduler / orchestrator 测试（32 项）
```

## 运行

```bash
npm test     # 32 项：规范版本、资质证照、冲突原因、局部重排、抢占升级、幂等、脱敏
npm run drill   # 按 09:12 三伤并发 → 高温 → 证照 → 设备 → 改线 → 突发踩踏 逐步演示
npm run serve   # http://localhost:8088
```

### HTTP 速览

```bash
# 安全负责人签署（无权或有冲突返回 403/409，409 带冲突清单）
curl -X POST localhost:8088/plans -H 'content-type: application/json' \
  -d '{"at":"2026-10-03T10:00:00+08:00","signer_id":"S_LIN"}'

# 演练：09:12 路跑5公里点谁接手、交给谁
curl "localhost:8088/response?at=2026-10-04T09:12:00%2B08:00&position=P_RUN_KM5"

# 三处同时伤情
curl -X POST localhost:8088/response/batch -H 'content-type: application/json' \
  -d '{"at":"2026-10-04T09:12:00+08:00","positions":["P_RUN_KM5","P_FIELD_1","P_WALK_PARK"]}'

# 局部重排：高温 / 设备故障 / 证照到期 / 路线改变 / 时段改变
curl -X POST localhost:8088/adjustments/heat -H 'content-type: application/json' \
  -d '{"at":"2026-10-04T08:30:00+08:00","operator":"值班员","window":{"start":"2026-10-04T09:00:00+08:00","end":"2026-10-04T10:30:00+08:00"},"position_ids":["P_WALK_PARK","P_WALK_END"]}'

# 突发事件（现场临时点位 + 临时开辟通道）
curl -X POST localhost:8088/incidents -H 'content-type: application/json' -d '{
  "at":"2026-10-04T09:13:00+08:00","operator":"值班员","window_minutes":30,
  "ephemeral":{"position_id":"P_INC_GATE","name":"南门入口踩踏","at":[118.095,24.457],
               "group":"youth_ball","corridor_id":"C_INC_CHILD","corridor_minutes":10,"to_hospital_id":"H_CHILDREN"}}'

# 管理端解释 / 公开视图 / 受限健康库
curl localhost:8088/adjustments
curl localhost:8088/public-state | grep -c "高血压"     # 0
curl -X POST localhost:8088/health-records -H 'content-type: application/json' \
  -d '{"role":"medical_officer","scopes":["phi"]}'
```

路由清单：`POST /plans`、`GET /plans`、`GET /conflicts`、`GET /response`、`POST /response/batch`、
`POST /adjustments/{heat,device,credential,corridor,window}`、`POST /incidents`、
`POST /notifications`、`GET /tasks`、`GET /adjustments[/{id}]`、`GET /public-state`、`POST /health-records`。

## 设计取舍

- **预指派而非现场撮合**：答案在签署时即确定，演练人员给一个时刻和点位就能读出完整交接链；时间槽（10 分钟）是调度与去重的最小单位。
- **锁定 + 解锁集合**保证"只重排受影响岗位"，无需全量重排后再做差异解释。
- **纯函数调度器 + 有状态编排核心**：`buildSchedule(snapshot, overrides)` 无副作用，所有变更都以覆盖层表达，便于回放与审计。
- 坐标/耗时为球面距离的确定性估算；接入真实路网时替换 `scheduler.js` 中的 ETA 计算即可，编排语义不变。
