# Windows 版 Claude Science 应用（AIUsage 风格 UI）· 实施规划

> 本文件是已批准规划的落盘快照（批准时间 2026-10-07 03:38），**不随实施进展改写**；
> 进展与偏差记录在文末「实施状态」一节。
>
> 代码位置：`tools/windows/science-proxy/`（`tools/` 已被仓库 `.gitignore` 忽略，不入库）。

## 0. 目标与约束

- **终态**：像现有 AIUsage 那样**带 UI 的 Windows 桌面应用**，统一管理「登录态 → 会话 → 推理 → 上游 → 成本」全链路。
- **首版交付**：Electron 桌面应用，**本机开发模式运行**（`npm start` / 快捷方式），不做安装包。
- **明确不做**：开机自启（按你的要求）；不改 Science 二进制；不写系统环境变量。
- **起点**：已完成并实测通过的 Node 后端 `tools/windows/science-proxy/`（49 项测试全绿，端到端已验证）。
- 首版 UI 覆盖你选的全部六个模块：状态与启停、节点与模型映射、实时日志与调用记录、成本与用量、登录态与备份、桌面 app 免登录开关。

## 1. 现状：可直接复用的资产（不重写后端）

| 已实现 | 位置 | 在应用里的角色 |
|---|---|---|
| 推理代理（假 Anthropic ⇄ 真 OpenAI Chat） | `src/inference-server.mjs` + 转换层 | 主进程托管的子服务，直接 `import` |
| 会话反代（免登录、Origin/CSRF 处理） | `src/session-proxy.mjs` | 同上 |
| daemon 控制（nonce/cookie/健康/停止） | `src/science-control.mjs` | 服务层，直接 `import` |
| 虚拟登录（逆向出的令牌格式 + 护栏） | `src/virtual-login.mjs` | 登录态页 |
| 配置与强校验 | `src/config.mjs` | 扩展为多上游 + 档位 |
| 上游能力探测（只走流式） | `src/probe.mjs` | UI「一键探测」按钮 |
| 备份/还原 | `science-control.mjs` | 备份页 |
| 端到端脚本 | `scripts/*.ps1` | 逻辑迁入 Node 编排层；PS 保留为无 UI 备用入口 |

现有代码已是「库 + CLI」双层（`createInferenceServer` / `createSessionProxy` / 各控制函数均为导出），Electron 主进程可直接调用。

## 2. 目标架构

```
Electron 主进程 (main)  窗口 / 托盘 / 生命周期 / IPC
  └─ app-service.mjs（编排层，新增）：起停顺序、健康监控、事件总线、统一回滚、日志汇聚
       ├─ inference-server  子进程 :14402
       ├─ session-proxy     子进程 :8000 → :8010
       ├─ claude-science daemon 子进程 :8010 / :8001
       └─ virtual-login / science-control（进程内调用）
        ↓ preload（contextBridge 窄 API）
渲染进程（Web UI，与 AIUsage 页面 1:1 对应）
  仪表盘 · 节点与模型映射 · 实时日志 · 成本与用量 · 登录态与备份 · 设置
```

- UI 用**原生 ESM + CSS，不引入构建工具**（与现有零依赖风格一致，改完刷新即生效）；后续复杂化再考虑 Vite。
- **托盘 ≠ 开机自启**：仅在手动运行时常驻托盘，不写注册表启动项。

## 3. 目录规划

```
tools/windows/science-proxy/
├─ package.json              # 新增 electron（devDependency）与 npm start
├─ electron/
│  ├─ main.mjs               # 主进程：窗口、托盘、生命周期、IPC 路由
│  ├─ preload.mjs            # contextBridge 窄 API（不暴露 Node）
│  └─ ipc/                   # status / config / logs / analytics / login / adopt
├─ src/
│  ├─ app-service.mjs        # ★新增：编排层（把 start.ps1 的 8 步搬到 Node，带进度事件与回滚）
│  ├─ log-bus.mjs            # ★新增：各进程 stdout → 结构化事件
│  ├─ analytics-store.mjs    # ★新增：调用记录 JSONL + 按日/模型聚合（含上游 cost）
│  ├─ adopt/                 # ★阶段 4：桌面 app 免登录
│  └─ …（现有模块保持不变）
└─ ui/
   ├─ index.html / styles.css
   └─ views/{dashboard,node-config,logs,analytics,login,settings}.mjs
```

## 4. 分阶段实施

### 阶段 1 · 编排层 + 仪表盘 + 一键启停（首版骨架）
- `app-service.mjs`：把 `start.ps1` 的步骤改为 Node 编排——备份 → 确保虚拟登录 → 清残留 → 起推理代理 → 起 daemon（带 env）→ 等健康 → 起会话反代 → 自探公开入口；暴露 `start/stop/restart/status` 与事件流（stage/progress/error），任一步失败**统一回滚**。
- IPC + 仪表盘：链路健康（14402/8010/8000）、进程 PID、当前节点与模型、启停按钮、最近错误。
- 验收：UI 点「启动」→ 浏览器免登录可用；点「停止」→ 无残留进程/端口；失败时 UI 显示具体阶段与原因。

### 阶段 2 · 节点与模型映射配置（含多档位）
- 配置扩展：`upstreams[]`（多上游：baseURL/key/能力标记）+ `models[]` 增加 `tier`（`opus|sonnet|haiku|default`），让主对话 / 子代理 / 辅助调用分别指向不同模型——**解决现在「辅助调用被回退打到主力模型」的浪费**。
- UI：上游列表（密钥掩码）、档位映射下拉、**一键探测**（流式探测并回填 `supportsTools`/`sendStreamUsage`/`supportsReasoningEffort`）、保存后热生效或提示重启。
- 沿用强校验：端口两两互斥、`%VAR%` 未展开报错、`publishAs` 唯一。
- 验收：UI 改档位 → 重启链路 → Science 选择器显示对应槽位 → 日志确认打到正确上游模型。

### 阶段 3 · 实时日志 + 调用记录 + 成本统计
- `log-bus.mjs`：三进程 stdout 汇聚为结构化事件；推理代理日志改为 **JSON 行**（保留人类可读版）。
- `analytics-store.mjs`：每次调用落 JSONL（时间、节点、发布模型、真实模型、耗时、TTFT、输入/输出/缓存 token、上游 `cost`/`gateway_cost`、成败与错误摘要），按日/模型/节点聚合。
- UI：日志页（级别过滤、搜索、跟随滚动）+ 分析页（趋势、Top 模型、失败率、累计成本）。
- 验收：跑 20 次对话后 UI 显示总数/成本/耗时分布，并能从日志定位到具体请求。

### 阶段 4 · 桌面 app 免登录（先 spike 再实现）
- **先做可行性验证**：Windows launcher 在 8000 被占时的行为（对应 macOS 的 `operon.lock` + successor 让位），必须实测确认「successor 判定依据」与「真实 pid 对齐」。
- 可行 → `adopt/` 实现占端口 + 改写运行期 lock + pid 对齐；UI 开关**默认关**，附风险说明与一键还原。
- 不可行 → 降级为「一键打开已登录入口」并明确说明，不伪装支持。

### 阶段 5 · 登录态与备份管理 + 运维项
- 登录态页：provider/email/org/是否虚拟、写入/移除、**备份列表与一键还原**。
- 运维：`doctor`（把 0.1.56 逆向假设变成可复现断言：nonce 端点、CSRF 机制、令牌格式、`/api/models` 来源）；失败重试 / 多上游 failover（实测网关偶发 `500 empty response content`）；日志轮转；密钥不落明文。
- **不做**：开机自启。

### 阶段 6 ·（可选，终态打磨）
- 托盘图标与快捷菜单（启停/打开界面/退出，仅手动运行时常驻）。
- 打包安装包（NSIS/MSI）——首版不做，留作后续。
- 主题与多语言（对齐 AIUsage 深色观感与中英切换）。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| Electron 首次下载约 100–200MB | UI 与主进程逻辑对「本地 Web 控制台」100% 复用；下载受阻就先交付浏览器控制台再换壳 |
| 桌面 app 免登录可能不可行 | 阶段 4 先 spike 后实现；失败则降级并如实说明 |
| 多上游/多档位使配置变复杂 | 默认单上游；UI 用「简单/高级」两态 |
| 长会话/大 artifact 的流式与内存 | 阶段 3 顺带做背压与内存上限回归 |
| Science 升级破坏私有协议 | `doctor` 断言 + 明确报错，绝不静默失败 |
| 端口冲突（8000/8001/8010/14402） | 启动前仲裁 + UI 明确提示占用者 |

## 6. 首版验收清单

1. 一条命令（或双击快捷方式）启动应用，UI 显示链路状态；
2. 一键启停，无残留进程/端口；
3. UI 内改配置（多档位映射）生效，并可用「一键探测」验证上游能力；
4. 日志与调用记录实时可见；成本统计与上游返回一致；
5. 登录态可查看/写入/移除，备份可一键还原；
6. 不写系统环境变量、不设开机自启、不修改 Science 二进制；
7. `node --test` 全绿（含新增编排层/分析层单测）。

## 7. 工作量预估

| 阶段 | 预估 |
|---|---|
| 1 编排层 + 仪表盘 | 0.5–1 天 |
| 2 多档位与节点配置 | 1 天 |
| 3 日志/记录/成本 | 1–1.5 天 |
| 4 桌面 app 免登录 | 0.5–2 天（取决于 spike） |
| 5 登录态/备份/doctor/重试 | 0.5–1 天 |
| 6 托盘/打包（可选） | 0.5 天 |

## 8. 计划产出物

- 新增：`electron/main.mjs`、`electron/preload.mjs`、`electron/ipc/*`、`src/app-service.mjs`、`src/log-bus.mjs`、`src/analytics-store.mjs`、`ui/*`、`src/adopt/*`（阶段 4）
- 修改：`package.json`（electron devDependency + `npm start`）、`src/config.mjs`（多上游/档位）、`src/inference-server.mjs`（JSON 日志行）
- 文档：本规划落盘为 `docs/WINDOWS_SCIENCE_APP_ROADMAP.md`，并在 `README.md` 增加「桌面应用」章节
- 每阶段结束跑 `node --test` + 真实链路回归（免登录 → 模型目录 → 对话 → 工具调用）

## 9. 需要你提供 / 确认

1. **Cline 套餐里用于档位映射的另外 1–2 个模型名**（主力用哪个、快速用哪个）；否则阶段 2 先按「三档指向同一模型」上线。
2. 是否接受把 **Electron 作为 devDependency**（首次约 100–200MB 下载）。
3. PowerShell 脚本是否保留为无 UI 备用入口（默认保留）。

---

## 实施状态

### 阶段 1（已完成，2026-10-07）

交付物与规划的偏差，逐条说明：

| 规划项 | 实际实现 |
|---|---|
| `src/app-service.mjs` | 已交付。9 阶段编排（validate → backup → login → cleanup → inference → daemon-start → daemon-health → session → probe）、阶段事件流、统一回滚、残留清理（PID + 端口，白名单校验后才杀）、`start/stop/restart/status/open` + CLI |
| `src/log-bus.mjs` | 已提前落地**基础版**（环形缓冲 + 订阅者 + 子进程 stdout 按行接入 + 脱敏），阶段 3 在其上扩展 JSON 行与调用记录 |
| `electron/main.mjs` | 已交付。窗口 + 编排层宿主 + `aiusage://` 自定义协议（file:// 下 ES module 会被 CORS 拦）、单实例锁、界面层错误捕获、`--smoke` 自动化自检 |
| `electron/preload.*` | 已交付，**文件名是 `preload.cjs`**：Electron 的沙箱化 preload 不支持 ESM，用 `.mjs` 会报 “Cannot use import statement outside a module”。为保住 `sandbox: true` 才改用 CommonJS |
| `electron/ipc/` | 已交付 `index.mjs`（status/config/start/stop/restart/open-entry/logs + 事件与日志推送）。analytics / adopt 频道留到阶段 3/4 |
| `ui/` | 已交付 `index.html`、`styles.css`、`dom.mjs`、`app.mjs` + 六个视图。仪表盘与实时日志为可用功能；节点与模型映射 / 登录态为**只读**；成本与用量为**阶段 3 占位**（不做假数据） |
| `package.json` | 已加 `electron` devDependency、`npm start`，并修掉原先重复的 `test` 键 |
| 单测 | `test/app-service.test.mjs`（17 项，全部依赖注入，不碰真实端口/进程）。全量 `node --test` **65/65 通过** |

实施中发现并修掉的问题：

1. `log.mjs` 的文件日志流在目录被清理时会抛未捕获 `error` 导致进程崩溃 → 已加降级处理（只保留 stdout）。
2. `sandbox: true` 下 preload 必须是 CommonJS → 改为 `preload.cjs`。
3. `ui/dom.mjs` 的 `append` 未处理嵌套数组/null → 已修，避免把 `null` 渲染成文本。

验证证据（真实链路，全部经编排层）：

- `node --test "test/*.test.mjs"` → **65/65 通过**
- Electron `--smoke` → `SMOKE OK`（渲染进程就绪、CSP/preload/IPC 全通、`interfaceErrors: []`）
- 真实链路回归 **22/22 通过**：起链 → 公开入口免登录 200 + HTML → `/api/models` 含 `claude-opus-5` 且无 `auth_error` → 新建 project/frame → 发消息 → 产生新的助手回复 → 日志确认 `claude-opus-5 → cline-pass/deepseek-v4.1-flash` 且 `stream=true`、`out>0`、日志无明文密钥 → 停止后无残留端口、无 `claude-science` 进程

档位决定：四档全部指向同一个模型（你的决定），以后要分流只需在「节点与模型映射」页加一个模型再把对应档位指过去。

---

## 阶段 2–6 实施状态（已完成，2026-10-07）

| 阶段 | 交付 | 关键实现 |
|---|---|---|
| 2 · 节点与模型映射 | 多上游 + 档位 + 可编辑 UI + 一键探测 | `config.mjs` 支持 `upstreams[]`（旧写法 `upstream` 仍兼容，两者同时出现直接报错）；`tiers` 四档默认全部指向默认模型；`model-map.mjs` 新增 `classifyTier()`：型号精确命中不了时按家族词（opus/sonnet/haiku）分档再查 `tiers`；推理代理按「解析出的模型 → 该模型的所属上游」选择 baseURL/密钥/能力/超时；`saveConfigPatch()` 合并 → 校验 → 原子落盘（失败时磁盘不动）；UI 可增删改上游与模型、改档位、逐上游「一键探测」（只走流式，回填 `supportsTools`/`sendStreamUsage`/`supportsReasoningEffort` 建议） |
| 3 · 成本与用量 | 调用记录 JSONL + 聚合 UI | `analytics-store.mjs`：每次上游调用一条记录，按天分文件 `<logging.dir>/analytics/calls-YYYY-MM-DD.jsonl`；字段含发布模型/真实模型/上游 id/命中原由（含档位）/token/耗时/TTFT/工具调用数/**上游返回的真实 `cost` 与 `gateway_cost`**/成败与错误摘要；写盘失败只降级不影响推理；UI：汇总（调用数、成功/失败、失败率、成本、P95、TTFT、token）+ 按天/按模型/按上游 + 最近调用 + 错误摘要 |
| 4 · 桌面 app 免登录 | **无需 hack，实测天然成立** | 见下方「阶段 4 spike 结论」 |
| 5 · 登录态与备份 | 写入/移除虚拟登录 + 备份列表/一键还原 + doctor | 服务层新增 `loginWrite/loginRemove/backupsList/backupCreate/backupRestore/doctor`；危险操作两步确认；`doctor.mjs` 把逆向假设做成 9 项可复现断言（二进制 / 数据目录 / `encryption.key` / 令牌数量与 v2 格式 / daemon 健康 / CSRF=204+`operon_csrf` / 写请求缺 Origin → 403 `origin_required` / CLI 铸 nonce / 推理代理按 Anthropic 形状发布模型） |
| 6 · 托盘与打包 | 托盘 + NSIS/免安装 + GitHub Actions | 关闭窗口收进托盘（链路继续），托盘菜单含启停/重启/打开浏览器界面/打开桌面 app/退出；托盘图标由 `scripts/make-tray-icon.mjs` 用 zlib 手写 PNG 生成（无图形依赖）；`electron-builder` 产出 NSIS 安装包与 portable；打包版配置播种到 `%APPDATA%\aiusage-science-proxy\config.json`（真实密钥不入安装包）；仓库独立为 `cjdem/AIUsage-Windows`，CI 是 `.github/workflows/build.yml`，用普通 `v*` 标签（与 macOS 那份仓库互不影响） |

### 阶段 4 spike 结论（桌面 app 免登录）

结论：**不需要实现「占端口 + 改写运行期 lock + pid 对齐」那套 adopt 逻辑**，因为桌面 app 天然会附着到我们已经在跑的 daemon。实测证据：

1. 在 8000（会话反代）与 8010/8001（我们的 daemon）都被占用的前提下，无参启动 `claude-science.exe`（等同双击桌面图标）**成功打开且没有另起 daemon**：8010/8001 仍归我们的 pid；`spawn.log` 在窗口启动期间没有任何新的 daemon 启动记录；进程组是桌面壳自己的若干子进程。
2. 数据目录里的 `auth-owner.lock`（`{nonce,pid,data_dir}`）由 daemon 写入并指向它自己，`reclaim-anchor.json` 记录 pid 与启动时间——桌面壳据此找到「已在运行的 owner」并附着。
3. daemon 自己发布 `Web UI → http://localhost:8010/?<nonce>`；用官方 CLI 铸 nonce → 换 cookie 后访问 `:8010/` 得到的是**已登录应用界面**（HTTP 200 / 4019 字节，与经反代的公开入口输出完全一致），不带凭证则被挡在登录门（401）。
4. 因此桌面窗口与浏览器窗口是同一份已登录应用，模型请求同样经 `ANTHROPIC_BASE_URL` 打到我们的推理代理。

由此 UI 里提供「打开桌面 app」按钮（无参启动，附着到当前 daemon），而不是引入脆弱的 lock 改写逻辑。

### 阶段 2–6 验证证据

- `node --test "test/*.test.mjs"` → **93/93 通过**（阶段 1 为 65；新增 `multi-upstream.test.mjs` 26 项、`analytics-store.test.mjs` 8 项）
- 开发态 `--smoke` → `SMOKE OK`（六视图零错误）；**打包态** `dist\win-unpacked\AIUsage Science Proxy.exe --smoke` → `SMOKE OK`（`packaged:true`、asar 内自定义协议与六视图正常、配置已播种到 `%APPDATA%`）
- 真实链路回归 **22/22**；阶段 4 daemon UI 验证 **7/7**（无凭证 401 → nonce 换 cookie → 200 已登录应用 + `/api/models` 含发布模型且无 `auth_error`）
- 收尾检查：无 `claude-science`/`electron` 残留进程，14402/8000/8010/8001 全部无监听，`state.json` 已清理
- 打包产物：`AIUsage Science Proxy-0.3.0-setup.exe`（106 MB）、`-portable.exe`（106 MB）

### 与规划的偏差（如实记录）

1. 档位映射放在 `tiers`（档位 → publishAs）而不是 `models[].tier`：路由只需一处真相，避免两份数据打架。
2. 未单独做「推理代理 JSON 行日志」：机器可读的结构化记录由 analytics JSONL 承担，普通日志保持人类可读。
3. 本地打包时 electron-builder 的工具链下载会被本机 TLS 代理拦（`self-signed certificate in certificate chain`），
   需要 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 加
   `NODE_TLS_REJECT_UNAUTHORIZED=0`；GitHub Actions 的 runner 无此问题，CI 里不需要这两个变量。
4. 「关闭窗口」的语义从「停止链路」改成「收进托盘」（有托盘后更安全），退出才停链；UI 与 README 已同步。
5. 阶段 1 复查时发现并修掉一个真实 bug：`status()` 计算了登录态却漏放进返回值，导致界面上的登录态一直是空的；
   已补上并加了单测防回归。

### 独立仓库与 CI（方案 B，已上线）

按你的决定采用**方案 B**：`tools/windows/science-proxy/` 整体作为独立公开仓库
[`cjdem/AIUsage-Windows`](https://github.com/cjdem/AIUsage-Windows)。本目录自带的 `.gitignore` 继续排除
`config.json`（真实密钥）/ `node_modules` / `dist`；工作流里的护栏会在 `config.json` 被跟踪时直接失败。

- CI：`.github/workflows/build.yml`，三个作业 `guard → test → package`（推送到 `main` 或打 `v*` 标签触发）。
- 打 `v*` 标签时额外把安装包挂到该标签的 Release。
- 已实测跑通：`v0.3.0`、`v0.3.1` 两次发布；工作流徽章 `Build - passing`；
  Release 资产为 `AIUsage-Science-Proxy-<版本>-setup.exe`、`-portable.exe`、`-setup.exe.blockmap`。
- 本地打包遇到的 TLS 代理问题（需要 npmmirror 镜像 + 临时关闭证书校验）只在这台机器需要，CI runner 不需要。
- 推送前做过「真实密钥形态」扫描（`sk_` + 长十六进制、`sk-ant-api/oat/ort…`、已知片段、长 hex 串），
  50+ 个已跟踪文件全部通过；唯一命中是被白名单放行的假令牌 `sk-ant-virtual-aiusage-local`
  （本工具写进虚拟登录的占位 access_token，不是真凭据）。
- 附录：GitHub 会把 Release 资产名里的**空格替换成点**，所以命名统一改用连字符
  （`AIUsage-Science-Proxy-…`）；`v0.3.1` 的免安装版仍是旧模板（带点），下一个版本起统一。
