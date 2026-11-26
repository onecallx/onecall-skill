# TDD 证据报告：v0.2 三层测试（单元既有 + 属性 + 差异 + 端到端）

日期：2026-11-26 · 分支：check-skill-format · 运行器：`node --test`（Node 22.21）

## 来源计划

- 设计：`docs/superpowers/specs/2026-11-26-skill-v0.2-task-template-design.md`
- 实施计划：`docs/superpowers/plans/2026-11-26-skill-v0.2-task-template.md`
- 本轮 journeys：① Agent 提交的联系人号码被正确归一且与服务端一致 ② 校验层拒绝畸形输入且不发出请求 ③ 用户在真实站点可走完模板→创建→启停→查询全旅程

## 任务报告

| 层 | 文件 | 执行摘要 | 命令 | 结果 |
| --- | --- | --- | --- | --- |
| 属性 | tests/property/normalize-phone.test.mjs | 3 不变量 × 300–500 次种子随机（mulberry32，PBT_SEED 可复现） | `node --test tests/property/` | 3/3 PASS |
| 差异 | tests/differential/server-parity.test.mjs | CLI 镜像 vs 服务端 outbound-guard 真源码（剥离 db import，经服务端 tsx 执行），415 输入逐字节比对 | `node --test tests/differential/` | 1/1 PASS（零偏差） |
| E2E | tests/e2e/live-service.test.mjs | 真实 develop 服务全旅程（只读 + 写全链路） | `ONECALL_E2E=1 node --test tests/e2e/` | 3/3 PASS |
| 全量 | tests/**/*.test.mjs | 单元+属性+差异+E2E 合跑 | `ONECALL_E2E=1 node --test --experimental-test-coverage "tests/**/*.test.mjs"` | 34/34 PASS，0 skip |

## 测试规格（本轮新增保证）

| # | 保证 | 测试 | 类型 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | 归一化幂等：f(f(x))===f(x)，任意装饰数字串 | property: 属性：归一化是幂等的 | property | PASS |
| 2 | 归一化只删不增：输出纯数字且为输入数字子序列 | property: 归一化只删不增 | property | PASS |
| 3 | 前缀剥离与移植契约一致（0086/86 剥 11 位数字；0 仅剥手机号形态） | property: 前缀剥离规则 | property | PASS |
| 4 | CLI 归一化与服务端 outbound-guard 真实现逐字节一致（415 输入） | differential: 与服务端真实现完全一致 | differential | PASS |
| 5 | 真实站点：status/market/templates/legacy 标记全部如实 | e2e: 只读旅程 | e2e | PASS |
| 6 | 真实站点：legacy 任务 show/progress 404、numbers/calls 200 | e2e: legacy 任务 | e2e | PASS |
| 7 | 真实站点：创建受理+未授权 auto_start 非运行+幂等重放一致+追加/控制受理+三类回读 | e2e: 写旅程 | e2e | PASS |

## RED→GREEN 记录

1. 属性-3 首跑 RED（`008623103550605`）——**发现**：服务端正则 `^0086\d{11}$` 与其注释"仅手机号"不符（不校验 1[3-9]），CLI 忠实移植。修正属性预期为实现契约并注明；服务端注释问题移交服务端维护者。
2. 差异测试侧车两轮修正：require→ESM；剥离顶层 db import（连 PG 挂起）——修正后首次真实比对即 GREEN（移植零偏差，也反向确认属性-3 的裁决正确）。

## 覆盖率

`node --test --experimental-test-coverage "tests/**/*.test.mjs"`（E2E 开启）：
`onecall.mjs — 行 99.66% / 分支 81.76% / 函数 100%`（门槛 80% 达标；未覆盖 2 行为 CLI 直调入口守卫）。

## 已知缺口

- E2E 默认跳过（需 ONECALL_E2E=1 + 本地 develop 服务/模板/团队 Key）；CI 无环境时仅跑 31 例。
- 差异测试绑定本机 /opt/www/onecall1（存在性探测，缺失即 skip）。
- 号码级真实接通仍受服务端调度 skip 行为阻塞（见实施计划 ledger），不在测试层解决。

## 合并证据

本轮提交：`test: add property/differential/e2e test layers (34 tests, 99.66% line coverage)`。若 squash，请保留本表与上表入 PR 体。
