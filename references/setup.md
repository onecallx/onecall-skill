# 安装与配置

将完整的 `onecall-phonecall/` 目录安装到宿主支持的 skills 目录，保留 `scripts/`、`references/`、`release.json` 和 `SKILL.md`。可从 OneCall 的「Agent 技能」页面下载 `.skill` ZIP 包；不要把下载到的 HTML 错当安装包。已有同名目录时先核对版本与本地修改，不直接覆盖。

常见目录：Codex `~/.codex/skills/`、Claude Code `~/.claude/skills/`、WorkBuddy `~/.workbuddy/skills/`、OpenClaw `~/.openclaw/skills/`；以宿主实际配置为准。安装后重新加载技能或新开对话。不需要安装第三方 npm CLI。

运行环境为 Node.js 20+。只将配置放在用户指定的本地环境中，未授权时不要改 shell 启动文件。

| 环境变量 | 含义 |
| --- | --- |
| `ONECALL_BASE_URL` | OneCall 服务源地址。不配置时默认 `https://api.16x.tech`；自建部署才需要设置。线上必须 HTTPS，不要附加 `/api` 或 `/v1`。 |
| `ONECALL_WEB_URL` | 网页源地址。不配置时默认 `https://app.16x.tech`；自建部署未单独设置时与服务地址相同。 |
| `ONECALL_API_KEY` | 用户在 OneCall 开发者页创建的团队 API Key。公开市场不需要。 |
| `ONECALL_CREDENTIALS_FILE` | 可替代密钥环境变量，指向用户自己准备的私密 JSON 文件，结构为 `{"apiKey":"…"}`。macOS/Linux 文件权限须为 0600。不要把文件内容回显到对话。 |
| `ONECALL_STATE_DIR` | 可选，本地操作记录目录；默认 `~/.local/state/onecall-skill`。macOS/Linux 目录权限为 0700。不要共享给其他用户。 |

用户应在本地填写凭据，不向对话粘贴。需要的最小权限：

- 查询模板、任务、进度、号码与话单：`outbound:read`。
- 创建任务、追加联系人、启停任务：`outbound:read` + `outbound:write`。

`auth setup` 返回当前站点开发者页面的链接。Key 的权限和所属团队由服务器验证，Skill 不创建密钥、不修改用户权限、不选择其他团队。`status` 的 `apiKeyConfigured` 只表示本机有配置，不能当作登录成功。

常见恢复：连接失败时先核对默认站点或自建部署的 `ONECALL_BASE_URL` 源地址；401 核对密钥有效期，403 核对所需权限、团队可用状态；网络错误时只重试读请求。写请求未知时查看 `operation show <id>` 及实际业务状态，不能重新提交同一业务。本版本（0.2.0）面向任务模板版 OpenAPI：若 `templates list` 持续 404 且 `tasks list` 条目不含模板字段（无 `state_version`），说明站点可能仍是旧版营销员接口，已不再支持——请升级站点，不要换参数或换密钥重试。历史任务在列表中标记 `legacy_outbound`：`tasks show` 与 `tasks progress` 对其返回 404 属预期（该编号仅存在于历史路径），话单与号码请用 `tasks calls` / `tasks numbers` 查询；若任务编号确认是新任务仍 404，再按上面的旧版站点线索排查。
