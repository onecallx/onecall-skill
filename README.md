# OneCall 电话数字员工 Skill

在支持 Agent Skills 和本地命令执行的 AI 助手中查找电话员工、查询团队通话和任务，并在确认后管理外呼任务。

当前版本 **0.1.0**，协议 **1**。运行环境为 **Node.js 20+**；无第三方运行依赖，无需安装全局 CLI。

## 能做什么

| 功能 | 方式 |
| --- | --- |
| 搜索公开数字员工、查看详情与试听入口 | 直接查询，无需 API Key |
| 创建员工、调整配置、体验语音或电话 | 返回 OneCall 网页入口，在网页完成 |
| 查询团队员工、通话记录、任务与进度 | 使用团队 API Key |
| 创建任务、导入 JSON 名单、启动/恢复/暂停外呼 | 先预览，授权后确认提交 |

## 安装

把这句话发送给支持本地工具执行的 AI 助手：

```text
请帮我安装 OneCall 电话技能：https://github.com/onecallx/onecall-skill
先读取 SKILL.md，保留完整目录，安装后告诉我如何配置 OneCall 站点。
```

也可以手动克隆到宿主支持的 Skills 目录。下面以 Codex 为例（已有同名目录时先核对本地修改）：

```sh
git clone https://github.com/onecallx/onecall-skill.git ~/.codex/skills/onecall-phonecall
```

Claude Code、WorkBuddy、OpenClaw 的常见目录见[安装与配置](references/setup.md)。Cursor 使用其实际配置的 Skills 目录。安装后重新加载技能或新开对话。仅支持网页聊天、不支持本地命令的工具无法直接运行本 Skill。

## 连接 OneCall

服务地址由你的 OneCall 部署决定，不要附加 `/api` 或 `/v1`。线上必须使用 HTTPS。以下是本地开发示例，使用线上服务时替换成自己的地址：

```sh
export ONECALL_BASE_URL="http://localhost:3002"
export ONECALL_WEB_URL="http://localhost:5173"
node ~/.codex/skills/onecall-phonecall/scripts/onecall.mjs status
node ~/.codex/skills/onecall-phonecall/scripts/onecall.mjs market list --q 回访
```

`export` 示例适用于 macOS/Linux。Windows 请使用所用终端的环境变量语法，并替换脚本路径。

公开查询无需密钥。团队操作需要在 OneCall 开发者页面创建 API Key，并在本机配置 `ONECALL_API_KEY`，或通过 `ONECALL_CREDENTIALS_FILE` 指向私密 JSON 文件。不要把密钥粘贴进对话或提交到仓库。`status` 只检查本地配置，不代表服务器授权成功。

最小权限：员工查询 `assistant:read`；通话查询 `calls:read`；任务查询 `outbound:read`；任务写入还需 `outbound:write`。

## 开始使用

```text
帮我找一位客户回访员工，先展示岗位与体验入口，不要发起通话。
查看当前团队的员工和最近通话。
为客户回访准备一个外呼任务，先让我确认任务参数。
```

创建、上传名单与启停任务会先返回预览。确认编号绑定目标和内容，15 分钟内有效。执行确认后，同一编号不会重复发送请求。遇到 `unknown` 状态时先核对操作记录和服务端业务状态，不重传、不重拨；本地防重不等于跨机器服务端幂等。实际拨打条件与费用以 OneCall 当前团队配置为准。

## 文档

- [SKILL.md：供 Agent 读取的执行规则](SKILL.md)
- [安装、环境变量与权限](references/setup.md)
- [业务命令、任务参数与恢复](references/workflows.md)
- [产品能力与交付边界](references/product.md)
- [版本元数据](release.json)

## 开发与验证

```sh
npm test
node --check scripts/onecall.mjs
```

测试使用 Node.js 自带测试运行器和模拟传输，不连接真实团队、不发起电话、不需要配置 API Key。无需先执行 `npm install`。

仓库根目录即 Skill 目录，包含 `SKILL.md`、`scripts/`、`references/`、`agents/` 和 `release.json`。仅发布 Skill 及其独立测试，不包含 OneCall 服务端、网站或本地凭据。

## License

MIT，见 [LICENSE](LICENSE)。
