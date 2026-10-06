# Windows 版 Claude Science 代理 · 技术文档

> 本文是 Windows 轨的**技术参考**：架构、逆向依据、实测结论、排障。
> 实现代码在 `tools/windows/science-proxy/`；macOS 轨的对应文档是 `docs/CLAUDE_SCIENCE_INTEGRATION.md`。
> 实测环境：Windows 11 + Claude Science **0.1.56**（bundled bun 单文件 `claude-science.exe`，161 MB）。

---

## 1. 目标与形态

无 Claude 账号、无订阅，把本地 Claude Science 的 **登录 → 会话 → 推理** 全链路代理到自选第三方模型，
保留工具调用 / Skill / MCP / 代码执行体验。

采用**进程外三层解耦**（不改 Science 二进制、不打补丁）：

| 层 | 进程 | 端口 | 职责 |
|---|---|---|---|
| 会话反代 | `src/session-proxy.mjs` | 8000（公开） | 铸 nonce→换 cookie，逐请求注入；改写 Origin/Referer/Host；WS 隧道；401/302 重铸 |
| daemon | `claude-science.exe serve` | 8010（内部）+ 8001（沙箱内容） | 官方行为不变，只是把推理指向本地代理 |
| 推理代理 | `src/inference-server.mjs` | 14402 | 假 Anthropic API ⇄ 真 OpenAI Chat；发布模型目录 |

数据流：`浏览器:8000 → 反代 → daemon:8010`（Web/会话）；`daemon → 14402 → 上游`（推理）。
两者完全独立，互不影响。

---

## 2. 登录态：为什么必须伪造凭证（Track A/Track B 结论）

**Track A（只用 env key）实测失败。** 以为 `ANTHROPIC_API_KEY` 足以让 daemon 免登录推理，实际：
- daemon 启动、Web 会话、`/api/frames` 建会话都正常；
- 但发出消息后 daemon 日志出现 `[ops.system.models] auth failed: No credentials available for Anthropic API`
  与 `[AgentService] Completed: frame=… status=error`；
- 会话确实接受了消息，但**推理从未发起**（我们的 14402 收不到任何 `/v1/messages`）。
- 读取源码可确认原因：`I8(cred)` 这个「订阅凭证」判定要求
  `cred.source === "oauth_token" && cred.auth_token`，**且** `baseURL === api.anthropic.com`；
  env key 走的是另一条 `api_key` 通路（用于 count_tokens/辅助调用），**且被 baseURL 检查排除**。

**Track B（本地伪造 OAuth 凭证）实测成功。** 于是改为写入一份 daemon 认可的虚拟凭证，
`/api/auth/status` 立即变为 `authenticated: true`，agent 开始正常调用模型。

### 2.1 凭证存储格式（逆向自二进制，字节级）

```
文件： <dataDir>/.oauth-tokens/<user_id>.enc          （UTF-8 文本，权限 0600）
格式： "v2:" + base64( IV(12) ‖ AES-256-GCM(明文) ‖ authTag(16) )
密钥： HKDF-SHA256(ikm = base64Decode(OAUTH_ENCRYPTION_KEY), salt = 空,
                   info = "operon:aes-256-gcm:oauth", 长度 = 32)
AAD ： "v2:oauth"
明文： JSON，含 access_token / refresh_token / token_expires_at / provider /
      scopes / email / account_uuid / subscription_type / org_uuid ...
```

对应源码片段（bun 打包后可读）：

```js
lse = { oauth_token: "oauth", anthropic_api_key: "apiKey", user_secret: "userSecret" }
function Ars(e){ let n = D7n(e);
  return Buffer.from(aRc("sha256", Buffer.from(n,"base64"), Buffer.alloc(0),
                         `operon:aes-256-gcm:${lse[e]}`, 32)) }        // HKDF-SHA256
function lRc(e,t){ … createCipheriv("aes-256-gcm", key, iv, {authTagLength:16})
  cipher.setAAD(Buffer.from("v2:"+lse[t], "utf-8")); … return "v2:"+base64(iv‖ct‖tag) }
```

其他关键常量：
- `encryption.key` 是 `KEY=value` 文本，含 4 个 base64 密钥；本轨只用 `OAUTH_ENCRYPTION_KEY`
  （对应 `lse.oauth_token = "oauth"`）。Windows 另有 DPAPI 包装文件，但明文文件仍在。
- provider 名 = `claude_ai`；scopes = `user:inference user:file_upload user:profile user:mcp_servers user:plugins`。
- `subscription_type` 取值：`max` / `pro` / `team` / `enterprise`（来自 `organization_type` 映射）。
- **用户身份判定**：`fN()` 要求 `.oauth-tokens` 里**恰好一个 `.enc`**，文件名去掉 `.enc` 即 user_id；
  本机默认 user_id 为 `local-dev`（与 daemon 日志 `user=local-dev` 一致）。
- 登录判定 `die()`：`active-org.json` 的 `org_uuid`（不存在则为 null）与令牌的 `org_uuid` 一致即为已登录；
  本实现**不写** `active-org.json`，保持现有数据布局与历史会话不动。
- `token_expires_at` 设为远期（`2099-01-01`）→ 永不触发联网刷新。

### 2.2 本实现的护栏（`src/virtual-login.mjs`）

- 只写 `<dataDir>/.oauth-tokens/<user>.enc`；绝不改 `encryption.key`、绝不碰其它目录。
- `inspect` 尽力回环解密现有令牌；**发现真实登录（无 `aiusage_virtual` 标记且可解密）时拒绝覆盖**（需 `--force`）。
- 写入走 `tmp + rename`、模式 `0600`、写前拒符号链接；`remove` 只删带标记的文件。
- `email` 必须以 `.invalid` 结尾（RFC 2606 不可路由假账号）；`account_uuid` / `org_uuid` 必须是 UUID。
- 令牌明文不回显、不打日志（只打印长度/字段名）。

---

## 3. 会话反代：免点一次性链接

daemon 的登录门是 cookie 会话 + 一次性 nonce 链接（3 分钟、只登录一个标签页、daemon 重启即失效）。
逆向要点与实测：

| 事实 | 证据 / 处置 |
|---|---|
| `GET /` 无 `operon_auth` → 401 | 反代注入 cookie 后 → 200（实测 4019 字节 HTML） |
| 铸 nonce：`claude-science url --data-dir <dir>` 打印带 `?nonce=` 的链接 | 反代调用官方 CLI（只读命令），解析 nonce（不落盘、不打印） |
| 换 cookie：`POST /api/auth/nonce`（同源表单 `nonce=…&dest=/`）→ `Set-Cookie: operon_auth` | 反代实测 `status=200 cookies=[operon_auth]`；旧版回退 `GET /?nonce=…` |
| CSRF：`GET /api/csrf` → **204 + `Set-Cookie: operon_csrf`**；SPA 读出后放 `x-operon-csrf` 头 | 反代启动时取一次并随每个请求注入 |
| 同源校验：写请求只接受 daemon 自身 origin | 反代把 `Origin`/`Referer` 改写为 `http://localhost:8010`，`Host` → `localhost:8010` |
| **写请求强制要求 `Origin` 头**：缺失 → `403 {"code":"origin_required"}` | 反代在写请求缺 Origin 时补自身 origin（浏览器本来就会带） |
| CSRF 不匹配 → `403 {"code":"csrf_stale"}` | 反代始终用 cookie 罐里的 `operon_csrf` 值作头 |
| cookie 绑定 daemon 本次启动的签名密钥，daemon 重启即失效 | 反代检测 `401` 或 `3xx→/login` 时重铸一次并重试 |
| `/api/ws` 是长连 WebSocket | 反代做原值双向隧道（注入 cookie + 改写 Origin） |

**启动竞态（实测踩到并已修）**：daemon 刚起来的数秒内，官方 CLI 会报
`couldn't mint a sign-in link for the running daemon`。因此：
- `mintLoginURLWithRetry()`：8 次尝试、每次间隔 2s；
- 反代初始化失败**不再退出**，改为监听照常、后台每 5s 重试、请求按需触发（单飞，避免并发铸 nonce 互相打断）。
- `start.ps1` 的自探循环等待最长 60s。

---

## 4. 模型目录：从哪来、显示什么

- daemon 的 `/api/models` 由 `ops.system.models` 服务产出，其数据源是
  **`{ANTHROPIC_BASE_URL}/v1/models`**（Anthropic SDK `models.list`）。
- 实测（虚拟登录 + 我们的目录）：`/api/models` 返回
  `{"models":{"anthropic":[{"id":"claude-opus-5"}]},"default_model_id":"claude-opus-5"}`，
  且 **`auth_error` 与 `fetch_error` 均为空** → 目录确实来自本代理，选择器会显示我们的模型。
- 若登录态缺失，daemon 会退回**内置目录**并附 `auth_error`（实测：
  `claude-opus-5 / claude-sonnet-5 / claude-opus-4-8 / claude-sonnet-4-6`，`default=claude-sonnet-4-6`，
  `models_source=fallback`、`first_party_catalog=false`）——据此可一眼判断目录是否走了本代理。

**身份映射策略**（`src/model-map.mjs`）：
- 对外发布 `publishAs`（建议取内置目录型号，例如 `claude-opus-5`），进而让 effort/上下文上限按家族显示；
- 请求侧精确还原为真实上游模型名；未知的 Claude 形状型号（例如辅助调用的
  `claude-haiku-4-5-20251001`）按 `unknownModelPolicy` 回退到默认模型（实测辅助调用因此正常）。

---

## 5. 推理协议转换

`POST /v1/messages`（Anthropic）→ `POST {upstream}/chat/completions`（OpenAI）：

- system（字符串/块数组）→ `system` 消息；`tool_use` → `assistant.tool_calls`；
  `tool_result` → `role:"tool"`（置于同批用户文本之前，保证紧跟 `tool_calls`）；
  image/base64 → `image_url` data URL；`document` → 丢弃并记 debug 说明。
- `tool_choice`：`auto`→`auto`、`any`→`required`、`none`→`none`、`tool`→指定函数。
- Claude 专有字段（`metadata`/`context_management`/`mcp_servers`/`container`/`output_format`/`thinking`）
  一律不转发；`output_config.effort`（含 `xhigh`/`max`）在开启 `supportsReasoningEffort` 时映射为 `reasoning_effort`。
- 流式：`message_start → content_block_start(+delta…) → content_block_stop → message_delta → message_stop`；
  上游 `tool_calls` 的 name/arguments 分片按 index 累积，转成 `partial_json` 增量；
  `finish_reason` → `stop_reason`（`tool_calls`→`tool_use`、`length`→`max_tokens`）。
- 上游错误按状态码映射为 Anthropic 错误体（401→`authentication_error`、429→`rate_limit_error`、
  503/529→`overloaded_error`、422→400 `invalid_request_error`）。
- `POST /v1/messages/count_tokens` 本地启发式估算（字符数/4），不打上游。
- 未实现的其它 Anthropic 端点统一 404 并记一行 info（便于后续按需补齐）。

### 5.1 始终流式（针对本机上游的适配）

实测本机上游（Cline 网关 `api.cline.bot`，套餐模型名 `cline-pass/deepseek-v4.1-flash`）：
**非流式接口会静默失败**（200 + `message.content = null`；带 system 时 500 `empty response content`），
而**流式接口完全正常**（含工具调用分片与 usage）。

因此本代理**一律以 `stream: true` 请求上游**（不提供开关，避免误配）：

- 客户端（Science）要流式 → 把上游 SSE 翻译成 Anthropic SSE 逐片回传；
- 客户端要非流式 → 本地把分片聚合成一条完整的 Anthropic 消息再返回；
- 网关万一忽略 `stream:true` 回了 JSON（`content-type: application/json`，或首片不像 SSE）→
  自动按 JSON 解析，绝不产出「200 + 空回复」这种无诊断的失败。

---

## 6. 实测验收记录（本机，2026-10-06/07）

| 项目 | 结果 |
|---|---|
| 单测 + mock 上游集成测试 | **49/49 通过**（`node --test "test/*.test.mjs"`） |
| 登录态（虚拟凭证） | `/api/auth/status` → `authenticated:true`，provider `claude_ai`，`subscription_type=max` |
| 免登录（无 cookie 访问公开入口） | `GET http://localhost:8000/` → **200 + HTML 已登录页** |
| 模型目录 | `/api/models` → 我们的 `claude-opus-5`，**无 auth_error / fetch_error** |
| 经反代写入 | `POST /api/frames` → **201**；`POST /api/frames/:id/message` → **200 accepted** |
| 对话闭环 | 用户文本 `请只回答两个字：收到` → 模型回复 **`收到`**，`frame status=completed` |
| 推理链路 | 代理日志：`claude-opus-5 → cline-pass/deepseek-v4.1-flash (published) stream=true msgs=2 tools=25`，`ttft≈2.9s` |
| 工具调用 | 模型返回 `tool_use(search_skills)`，Science 执行后发起第二轮（`msgs=6`） |
| 辅助调用 | `claude-haiku-4-5-20251001 → cline-pass/deepseek-v4.1-flash (fallback-default)`，本地聚合成功 |
| 备份/还原 | 非破坏性回归测试通过；`start.ps1` 每次启动自动只读备份真实 data-dir |
| 日志脱敏 | 密钥/令牌/Cookie 打码；`describeConfig` 只输出 `<set>` |

---

## 7. 排障速查

| 现象 | 根因 | 处置 |
|---|---|---|
| `couldn't mint a sign-in link for the running daemon` | daemon 启动后控制通道未就绪（竞态） | 已内置重试；若频繁出现，稍等数秒或重启链 |
| 反代启动即退出 / 8000 无监听 | 早期版本在会话初始化失败时直接退出 | 已改为后台重试；确认 `session.log` |
| 对话回复为空 | 不该出现（一律流式调上游）；若出现看 `inference.log` 的 `json-fallback` 与上游正文摘要 |
| 写操作 403 `origin_required` | 客户端没带 Origin（脚本/非浏览器） | 反代已自动补；直连 daemon 时才需自己带 |
| 写操作 403 `csrf_stale` | `x-operon-csrf` 与 cookie 不匹配 | 反代用 cookie 罐的值；手工调试时须成对 |
| `auth failed: No credentials available` | 虚拟凭证缺失/被删 | `node src/virtual-login.mjs inspect` → `write` |
| 模型目录只有内置 4 个型号 | 目录走了 fallback（登录态或 baseURL 未生效） | 确认虚拟登录 + `ANTHROPIC_BASE_URL` 指向 14402，然后重启 daemon |
| daemon 重启后浏览器要重新登录 | cookie 绑定启动密钥 | 反代自动重铸；手动刷新即可 |

---

## 8. 与 macOS 轨的差异

| 维度 | macOS 轨 | Windows 轨（本实现） |
|---|---|---|
| 运行时 | Swift + CryptoKit | Node.js ≥ 20（纯 stdlib，无第三方依赖） |
| 虚拟登录加密 | CryptoKit AES-GCM + HKDF | `node:crypto` 同算法同参数（格式一致） |
| 会话获取 | 直接连 `daemon.sock`（Unix socket）`POST /nonce` | 调用官方 CLI `claude-science url`（Windows 无 socket 路径） |
| 接管真实实例 | 劫持 `operon.lock` 让双击 app 免登录 | **未实现**（下一步工作） |
| 沙箱隔离 | 独立 HOME + APFS 克隆 | 用真实 data-dir + 只读备份（本轨选择） |
| 模型目录 | 反代直出 `/api/models` 快照（绕过 daemon 缓存） | 依赖 daemon 自身从 14402 拉取（实测生效） |

---

## 9. 未完成 / 下一步

1. **桌面 app 免登录**：现在双击图标仍会启动它自己的真实实例。可参考 macOS 轨的
   `operon.lock` 劫持 + successor 让位方案，但需先在 Windows 上验证 launcher 的判定逻辑。
2. 会话反代直出模型目录（绕过 daemon 侧缓存），与 macOS 轨对齐。
3. 长会话/大 artifact 的流式与内存上限压测。
4. 版本升级回归：把 0.1.56 假设（nonce 端点、CSRF 机制、令牌格式、`/api/models` 来源）
   做成可重复的探测脚本，便于升级后快速判定兼容性。

---

## 10. 代码审查与修复记录

对该实现做过一轮只读安全/健壮性审查，发现的 18 项问题已全部处理，其中影响最大的四项：

| 严重度 | 问题 | 修法 |
|---|---|---|
| 严重（数据损坏） | 虚拟登录写入时对 `.oauth-tokens/` 里其它 `.enc` 无条件删除；若真实凭证解不开（密钥轮换/格式变化），会被误删且不可逆 | 只删除**明确带 `aiusage_virtual` 标记**的文件；存在任何不可判定/不可解密的凭证一律拒绝写入（需 `--force`）；并且改为「先写入成功再清理」 |
| 严重（暴露面） | 反代把会话身份注入**任意**入站请求，等于架空 daemon 的同源+CSRF 防线，恶意网页/DNS rebinding 可驱动本地 agent | 入口加白名单：Host 必须是回环 + 公开端口；写请求 Origin 必须为空或回环同端口，否则 403 |
| 中等 | 401 重铸后重试丢失请求体 / 重铸失败时请求永久挂起 | 请求体带上限缓冲后显式重发；重铸失败立即回 503 |
| 中等 | 上游 200 但返回非 SSE（网关忽略 `stream`）时静默产出空回复，无任何诊断信号 | 先按 content-type + 首片嗅探分流；非 SSE 走 JSON 解析，解析不了回 502 且带前 200 字节正文 |
| 中等 | 并行工具调用的参数分片跨 index 交错时，delta 会落到已关闭的块上（`tool_use.input` 变空） | 工具块统一在 `finish()` 按 index 顺序产出，并加「同一时刻只能有一个打开块」的回归测试约束事件序列 |

其余已修项：流式非 JSON 支路定时器泄漏、客户端断连时未取消上游、Ctrl+C 因 WebSocket 长连不退出、
`%VAR%` 未展开静默启动、四个端口未两两互斥、响应头整包透传（`Set-Cookie`/`Location` 治理）、
`tool_result` 缺配对 id / 上游不支持工具时的降级、日志中 `nonce=` 脱敏。

回归：`node --test "test/*.test.mjs"` → **49/49 通过**；随后重跑真实链路验收（§6）仍全绿。
后续调整：应上游只支持流式，已移除「非流式请求上游」这条支路（客户端要非流式时本地聚合），
并让 `probe.mjs` 只测流式（原先用非流式探测会误报「不支持工具」；实测流式下工具调用正常）。