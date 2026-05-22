# Patchlane 工程化 Agent 计划书

## 1. 项目定位

Patchlane 是面向中文开发者的 VS Code 工程 Agent 插件。目标不是做一个只会聊天的 AI 侧边栏，而是做一个可以理解工作区、搜索资料、规划任务、读写文件、运行验证、修复失败、展示修改并等待用户确认的工程化 Agent。

核心目标：

- 默认中文体验，普通用户只需要选择模型并填写 API Key。
- DeepSeek 优先接入，同时支持 OpenAI、Claude、国内主流模型、本地模型和自定义兼容接口。
- Chat 模式用于解释、分析、问答。
- Agent 模式用于真实工程任务：理解需求、检索上下文、调用工具、生成和应用可审查修改。
- 文件修改必须可见、可审查、可停止、可回滚。
- Skill、Tool、MCP、Web 搜索都走统一审批和审计。
- 最终体验和工程能力对标 Claude Code / Copilot Chat，并在中文、本地审批、可确认 diff、模型自由度上形成差异化。

## 2. 当前已完成能力

已完成的 MVP 能力：

- VS Code 插件基础结构：TypeScript、Webview、React、Tailwind、esbuild。
- 中文主界面：会话列表、聊天页、修改结果页、设置页。
- 多模型选择：DeepSeek、OpenAI、Claude、国内 OpenAI 兼容厂商、Ollama、LM Studio、自定义 OpenAI / Claude 接口。
- API Key 使用 VS Code SecretStorage 本地保存。
- Chat 流式输出和停止生成。
- Agent 生成可确认 unified diff。
- 修改结果页展示文件、增删行、diff 内容、质量审查。
- Agent 生成修改时实时流式更新“修改结果”。
- 应用修改、部分应用、放弃草稿、撤回上次修改。
- 当前文件优先的文件引用选择器。
- Skill / Tool / MCP 配置入口和标签展示。
- 页面内审批卡片，不依赖 VS Code 弹窗。
- 会话历史持久化。
- 选中代码解释卡片。
- 联网搜索工具：支持自定义 API、SearXNG、Tavily、Brave、Bing、SerpAPI。
- 联网搜索支持官方文档、GitHub、最新消息三类搜索倾向，并会优先排序官方来源。
- 搜索结果卡片、来源展示、页面内审批、Agent 上下文注入。
- 网页正文读取 `web.fetch`：搜索结果可审批后读取正文摘录。
- 第一版 Agent Orchestrator：本地分析任务、候选文件、关键文件、诊断和 Git 状态后再生成修改。
- 会话内验证命令：运行结果写回当前会话，供后续修复使用。
- 验证并修复：验证失败时自动生成新的可审查修复草稿。
- 应用修改后自动请求运行验证；验证失败时生成新的可审查修复草稿。
- stdio MCP Client：支持通过 `codeAgent.mcp.servers` 声明服务、调用 `tools/list` 自动发现工具，并在页面内审批后调用 `tools/call`。
- HTTP MCP JSON-RPC 和 SSE 响应兼容：支持 HTTP Server 连接、`tools/list`、`tools/call`，并可发现 `resources/list` 和 `prompts/list`。
- MCP 资源和 Prompt 首版：设置页集中展示工具、资源、Prompt；支持审批后调用 `resources/read` 和 `prompts/get`，并把结果写入当前会话上下文。
- MCP Prompt 参数表单：如果服务端声明 `arguments`，设置页会渲染参数输入框，并在必填项完整后调用 `prompts/get`。
- Agent 会在生成修改前执行已选择的脚本 Skill、脚本工具和具体 MCP 工具，并把输出合并进上下文。
- 模型驱动工具循环首版：生成 patch 前由模型按少量轮次决定读取文件、联网搜索、运行能力或验证命令。
- 新增上下文预算档位：`economy` / `balanced` / `quality`，统一控制候选文件、读取文件、历史、联网搜索、工具输出和验证输出的上下文长度。
- 新增工具循环轮次预算：`codeAgent.agent.maxToolRounds`，默认 2 轮，避免为追求质量无限消耗 token。
- Agent 记忆增强：当用户在同一会话中说“继续”“按上面的计划实现”“逐一完成所有任务”时，会提取前文计划、步骤、文件范围和验收标准作为独立上下文，减少任务偏离和历史 token 浪费。
- 长文件上下文改为头尾保留，避免只看到文件开头导致关键实现区域缺失。
- Patch 完整性审查会检查 hunk 行数和模型协议残留，发现疑似截断会判定失败。
- 模型失败归因：统一识别 API Key 未配置、空响应、只返回思考内容、上下文过长、限流、网络失败和服务端错误，并转换为中文可行动提示；模型完全未输出 diff 时，修改结果页仍保留失败状态和质量审查说明。
- 失败归因修正策略：模型空响应、上下文过长、patch 截断、修改范围偏离、应用冲突和验证失败会转换成下一步策略，注入修复提示，减少盲目重试和无关大改。
- 应用失败后，修复流程会读取失败 patch 涉及文件的当前内容，再生成可审查修复草稿。
- 质量审查未通过时禁用直接应用，减少不完整 patch 写入工作区的风险。
- 设置页可一键生成 `.patchlane` Skill / Tool / MCP 模板，并写入工作区设置。
- 支持 `.patchlane/patchlane.json` 项目级能力清单：团队可以把 Skill、Tool、MCP 服务随仓库共享，打开工作区后自动合并到 Agent 可用能力里。
- 设置页新增扩展能力工作台，集中展示 Skill、工具、MCP 和可执行脚本数量。
- 设置页支持图形化创建 Skill，并可在扩展能力工作台直接打开脚本或测试运行 Skill、工具和 MCP。
- 设置页新增 Skill / 工具 / MCP 最近运行记录，能查看 Agent 自动调用和手动测试的状态、退出码、命令和输出摘要。
- 设置页新增 Skill / Tool / MCP 配置诊断，能提示重复 ID、缺少可执行入口、MCP 路由缺失、MCP 服务错误和脚本路径风险。
- MCP 服务卡片已支持运行日志、重连、停止和清空日志。
- MCP HTTP/SSE 解析已抽成纯模块，并补充 plain JSON、批量响应、多事件 SSE、多行 `data:` 和 `[DONE]` 的回归测试。
- 验证命令升级为多命令套件，失败即停，并支持自动发现常见项目验证命令；同时对类型检查、测试、Lint、构建、依赖缺失、运行时错误进行分类。
- 停止按钮已覆盖 Chat 流式输出、Agent 生成、应用后验证、脚本 Skill 和 MCP 工具调用的主要路径。
- 会话重开后会识别遗留运行态，把未完成的进度卡标记为中断，并提供“重试上次请求”的恢复卡片。
- README 已中文化整理。
- 编译和基础测试通过。

当前主要短板：

- Agent 已具备模型驱动工具循环首版和失败归因修正策略，但还不是完整自主循环；后续需要更强的任务级动态计划修正。
- 已支持前文计划继承、模型调用失败归因和失败修正策略；后续还需要把策略扩展到任务检查点，让 Agent 能按阶段标记完成/阻塞并重新规划。
- MCP 已有 stdio、HTTP JSON-RPC、SSE 响应读取、资源读取、Prompt 获取、Prompt 参数表单、服务日志控制和项目级共享清单；后续重点是更完整的版本管理、远程导入和团队策略。
- 自动验证和修复闭环已支持自动命令发现、多命令套件、失败分类、失败修正策略，以及“验证失败 -> 生成修复草稿 -> 应用后再验证 -> 必要时继续生成下一轮草稿”的安全多轮流程；后续重点是任务检查点和计划动态修正。
- Skill / Tool / MCP 已有模板生成入口、图形化创建、项目级共享清单、能力工作台、脚本打开、测试运行、最近运行记录和配置诊断；后续重点是更完整的版本管理、远程导入和团队策略。
- 已支持中断识别和一键重试；受 VS Code 扩展主机生命周期限制，暂不支持窗口或扩展主机重启后继续原进程。
- 发布材料已补充 CHANGELOG、LICENSE、打包脚本、发布清单和贡献指南；本地 `.vsix` 已可生成。后续还需要截图、图标最终版和真实 GitHub Release 页面。

## 3. 目标架构

### 3.1 分层结构

```text
VS Code Extension Host
  ├─ Chat / Agent Orchestrator
  ├─ Model Router
  ├─ Tool Runtime
  │   ├─ File Tools
  │   ├─ Workspace Search Tools
  │   ├─ Terminal / Verify Tools
  │   ├─ Web Search Tools
  │   ├─ MCP Client Tools
  │   └─ Skill Runner
  ├─ Approval / Policy Guard
  ├─ Patch Engine
  ├─ Session / Task Store
  └─ Webview UI
```

### 3.2 Agent 执行循环

Agent 模式应从“生成一次 diff”升级为工具循环：

1. 理解任务
2. 读取当前会话上下文
3. 判断是否需要更多信息
4. 调用工具获取信息
5. 制定短计划
6. 修改文件或生成 diff
7. 运行验证命令
8. 根据失败输出修复
9. 输出最终总结和可审查修改

循环约束：

- 每一步要有明确状态，显示在页面进度流中。
- 每次读写文件、运行命令、访问网络、调用 MCP 都要经过审批策略。
- 大任务必须拆成小步，避免一次把上下文塞满。
- 默认优先读最相关文件，不扫描整个项目。
- 默认使用本地排序、去重、截断和预算控制节省 token；只有复杂任务或用户选择高质量档位时才扩大上下文。
- 修改必须通过 patch 草稿或受控写入工具展示。
- 出现失败要保留中间结果，用户可以停止、查看和重试。

## 4. Web 搜索工具设计

Web 搜索是 Agent 的一等工具，用于获取最新文档、最新 API、错误信息、框架变更、依赖版本说明、新闻或公告。它不能替代模型知识，而是作为“可引用、可追溯、可审批”的外部信息源。

### 4.1 内置工具

建议内置这些工具：

| 工具 ID | 名称 | 作用 |
|---|---|---|
| `web.search` | 网页搜索 | 搜索通用网页、官方文档、GitHub issue、错误信息 |
| `web.fetch` | 读取网页 | 打开指定 URL 并提取正文、标题、发布时间 |
| `docs.search` | 文档搜索 | 优先搜索官方文档，可按框架/语言/域名过滤 |
| `news.search` | 最新消息 | 搜索最近更新内容，支持时间范围 |
| `github.search` | GitHub 搜索 | 搜索仓库、issue、release、discussion |

首版可以先实现：

- `web.search`
- `web.fetch`
- `docs.search`

### 4.2 搜索服务适配

为了便于国内用户和企业环境使用，搜索后端不要锁死一家服务商。

支持优先级：

1. 自定义搜索 API
2. SearXNG 自建实例
3. Tavily
4. Brave Search
5. Bing Web Search
6. SerpAPI

配置项：

```json
{
  "codeAgent.webSearch.enabled": true,
  "codeAgent.webSearch.provider": "custom | searxng | tavily | brave | bing | serpapi",
  "codeAgent.webSearch.baseUrl": "",
  "codeAgent.webSearch.apiKey": "",
  "codeAgent.webSearch.maxResults": 8,
  "codeAgent.webSearch.defaultRecencyDays": 30,
  "codeAgent.webSearch.allowedDomains": [],
  "codeAgent.webSearch.blockedDomains": [],
  "codeAgent.webSearch.requireApproval": true
}
```

API Key 仍然用 SecretStorage 保存，不写入明文 settings。

### 4.3 搜索审批策略

Web 搜索属于网络访问工具，必须可控：

- 默认第一次搜索前请求页面内审批。
- 审批卡片必须显示搜索关键词、搜索服务商、是否带文件内容。
- 如果查询中包含代码片段、文件路径、错误日志，要提示可能泄露项目上下文。
- 支持“本会话允许 Web 搜索”。
- 支持“本会话允许同一域名读取网页”。
- 企业用户可以关闭 Web 搜索或限制域名。

### 4.4 搜索结果处理

搜索结果不能原样塞给模型，必须压缩和标注：

- 标题
- URL
- 摘要
- 发布时间或更新时间
- 来源域名
- 可信等级
- 相关性评分
- 是否官方来源

注入模型的上下文格式：

```text
Web search results:
1. [official] Title
   URL: https://...
   Updated: 2026-...
   Summary: ...
```

Agent 回复里必须：

- 标注引用来源。
- 对“最新版本/最新政策/最新 API”说明来源时间。
- 避免无来源地断言最新状态。

### 4.5 文档优先策略

当用户问 API、框架、依赖、模型、服务商接口时，Agent 应优先搜索：

- 官方文档
- 官方 release notes
- GitHub 官方仓库
- SDK README
- 标准规范

低优先级：

- 博客
- 论坛
- 未注明时间的教程
- 转载站

### 4.6 Web 搜索 UI

在输入框底部工具区增加：

- `搜索` 工具标签
- 开关：允许联网
- 搜索结果引用面板
- 来源列表，可点击打开
- 搜索日志：查询词、时间、结果数、使用的来源

Agent 运行中显示：

```text
正在搜索：React 19 useActionState 官方文档
已读取：react.dev/reference/react/useActionState
已引用：3 个来源
```

## 5. Tool Runtime 设计

### 5.1 工具统一协议

所有工具都抽象成统一接口：

```ts
interface AgentTool {
  id: string;
  label: string;
  description: string;
  inputSchema: JsonSchema;
  risk: "low" | "medium" | "high";
  requiresApproval: boolean;
  run(input: unknown, context: ToolContext): Promise<ToolResult>;
}
```

统一工具结果：

```ts
interface ToolResult {
  ok: boolean;
  title: string;
  content: string;
  artifacts?: ToolArtifact[];
  citations?: Citation[];
  error?: string;
}
```

### 5.2 内置工具清单

第一批内置工具：

- `workspace.listFiles`
- `workspace.readFile`
- `workspace.searchText`
- `workspace.searchSymbols`
- `workspace.getDiagnostics`
- `workspace.writePatch`
- `workspace.applyPatch`
- `terminal.run`
- `verify.run`
- `web.search`
- `web.fetch`
- `mcp.callTool`

### 5.3 风险等级

低风险：

- 列文件
- 搜索文件名
- 搜索公开网页

中风险：

- 读取工作区文件
- 读取网页正文
- 运行只读命令

高风险：

- 写文件
- 应用 patch
- 运行 shell 命令
- 调用带副作用的 MCP 工具
- 上传代码片段到搜索服务

## 6. MCP 完整适配计划

### 6.1 当前状态

当前 MCP 更像“外部脚本入口”，能配置、能审批、能运行，但不是完整协议级 MCP Client。

### 6.2 目标能力

完整 MCP Client 应支持：

- `stdio` MCP Server
- `SSE / HTTP` MCP Server
- 工具发现
- 工具 schema 渲染
- 工具调用
- 资源读取
- Prompt 模板
- 服务启动/停止
- 日志和错误展示
- 每个 server 独立权限策略

### 6.3 配置示例

```json
{
  "codeAgent.mcp.servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "node",
      "args": [".patchlane/mcp/filesystem/server.js"],
      "cwd": "${workspaceFolder}",
      "env": {}
    },
    "docs": {
      "transport": "http",
      "url": "http://localhost:3333/mcp"
    }
  }
}
```

### 6.4 MCP UI

设置页增加：

- MCP 服务列表
- 状态：未启动 / 运行中 / 错误
- 工具数量
- 最近调用
- 权限
- 重新连接
- 查看日志

## 7. Skill 系统增强

### 7.1 Skill 定位

Skill 是“可复用的专业工作流”，不是简单提示词。它可以包含：

- 系统指令
- 任务流程
- 文件模板
- 本地脚本
- 可调用工具
- 验收标准

### 7.2 Skill 文件结构

推荐支持 workspace 内的 `.patchlane/skills`：

```text
.patchlane/
  skills/
    frontend-review/
      SKILL.md
      skill.json
      scripts/
      templates/
```

`skill.json` 示例：

```json
{
  "id": "frontend-review",
  "label": "前端体验审查",
  "description": "检查页面布局、交互、响应式和可访问性",
  "entry": "SKILL.md",
  "tools": ["workspace.readFile", "web.search"],
  "scripts": ["scripts/audit.js"]
}
```

### 7.3 傻瓜化添加

设置页提供：

- 新建 Skill
- 从模板创建
- 导入 GitHub Skill
- 打开 Skill 文件夹
- 验证 Skill 配置

## 8. Agent 质量提升策略

### 8.1 上下文节省

必须避免一次性把整个项目发给模型：

- 默认只读取当前文件、引用文件、相关搜索结果。
- 通过 `rg` 结果找候选文件。
- 大文件只取摘要和相关片段。
- 旧对话做摘要，不无限注入。
- 对工具结果做压缩。
- 对 diff 做文件级拆分。

### 8.2 计划-执行-验证

每个 Agent 任务都生成结构化计划：

- 任务目标
- 影响文件
- 执行步骤
- 验收标准
- 风险
- 需要补充的信息
- 验证命令

执行时按计划推进，但允许根据工具结果修正计划。

### 8.3 自动验证修复

Agent 应支持：

1. 生成修改
2. 运行验证命令
3. 读取失败输出
4. 定位错误
5. 生成修复 patch
6. 再运行验证
7. 达到上限后停止并解释

限制：

- 默认最多 2 次自动修复。
- 高风险命令每次都要审批。
- 失败输出要展示给用户。

## 9. UI 重构方向

### 9.1 页面结构

保留三大页面：

- 对话
- 修改结果
- 设置

对话页重点展示：

- 用户需求
- Agent 步骤流
- 工具调用卡片
- 搜索来源卡片
- 最终答复

修改结果页重点展示：

- 实时 diff
- 文件列表
- 质量审查
- 验证结果
- 应用 / 放弃 / 部分应用 / 回滚

设置页重点展示：

- 模型和 API Key
- Web 搜索
- MCP 服务
- Skill
- 安全策略

### 9.2 Agent 运行态

Agent 运行中需要显示：

- 当前步骤
- 已读取文件
- 已调用工具
- 已搜索网页
- 已生成修改
- 已运行验证
- 当前 token / 耗时估算
- 停止按钮

## 10. 安全和隐私

原则：

- API Key 只进 SecretStorage。
- 文件内容默认只发给用户选择的模型服务商。
- Web 搜索前提示可能泄露查询内容。
- 代码片段进入 Web 搜索需要额外提示。
- 所有写入必须可审查。
- 命令执行必须审批。
- 允许企业环境禁用网络工具。

建议增加配置：

```json
{
  "codeAgent.security.disableNetworkTools": false,
  "codeAgent.security.disableShellTools": false,
  "codeAgent.security.requireApprovalForReadFile": true,
  "codeAgent.security.requireApprovalForWebSearch": true,
  "codeAgent.security.maxAutoFixAttempts": 2
}
```

## 11. 阶段计划

### Phase 1：计划和文档整理

目标：

- 中文 README
- 本计划书
- 开发调试说明
- Skill / MCP / Web 搜索扩展说明

验收：

- 新用户能按文档启动调试插件。
- 能理解 Chat、Agent、Skill、MCP、Web 搜索的边界。

### Phase 2：Web 搜索工具

状态：已完成首版和搜索倾向增强。当前支持通用搜索、官方文档优先、GitHub 优先、最新消息优先。剩余增强为更多正文抽取策略、来源可信度 UI 和引用格式。

目标：

- 增加 WebSearchService。
- 支持至少一个搜索后端和自定义搜索 API。
- 增加 `web.search`、`web.fetch`、`docs.search`、`github.search`、`news.search` 的搜索倾向。
- 搜索前页面内审批。
- 搜索结果可显示、可引用、可注入 Agent 上下文。

验收：

- 用户在 Agent 模式下选择“搜索”后，Agent 能搜索最新官方文档。
- 搜索结果展示来源和时间。
- 停止 Agent 时能中断搜索和后续生成。

### Phase 3：Agent 工具循环

状态：已完成本地只读 Orchestrator、首版模型驱动工具循环和任务中断恢复卡片。Agent 现在会在生成 patch 前按 `codeAgent.agent.maxToolRounds` 做少量轮次的工具决策，支持读取文件、联网搜索、调用已选 Skill/MCP 和运行验证命令；完整自主循环和计划动态修正仍在进行。

目标：

- 引入 Agent Orchestrator。
- 支持模型请求工具调用计划。
- 支持文件搜索、文件读取、Web 搜索、生成 patch、验证命令。
- 工具结果实时显示。

验收：

- Agent 能根据任务自动搜索相关文件。
- Agent 能在需要最新信息时调用 Web 搜索。
- Agent 不是直接聊天式输出，而是逐步行动。

### Phase 4：自动验证和修复闭环

状态：已完成会话内“验证并修复”、应用修改后的自动验证、失败修复草稿、多轮修复草稿生成、自动发现常见项目验证命令、多命令验证套件、失败即停和失败类型分类。所有写入仍需要用户在修改结果页审查后手动应用；后续重点是更强的失败归因和计划动态修正。

目标：

- 验证命令自动选择和运行。
- 失败输出自动分析。
- 自动生成修复 patch。
- 最多重试次数可配置。

验收：

- Agent 修改后能运行测试。
- 测试失败时能读取错误并尝试修复。
- 所有修改仍然可审查、可停止。

### Phase 5：完整 MCP Client

状态：已完成 stdio `tools/call` 首版、HTTP JSON-RPC 基础调用和 `text/event-stream` SSE 响应读取；支持发现 `tools/list`、`resources/list`、`prompts/list`，能在页面内审批后调用 `resources/read` 和 `prompts/get`，并已支持 MCP Prompt 参数表单、服务重连、停止和最近日志。

目标：

- 支持 MCP stdio / HTTP。
- 工具发现。
- Prompt 参数表单。
- MCP 调用审批。
- MCP 日志页面。

验收：

- 用户能配置一个 MCP Server。
- Patchlane 能发现 MCP 工具并在 Agent 中调用。

### Phase 6：Skill 工作台

状态：已完成模板生成、图形化创建、能力工作台、配置诊断、打开脚本、测试运行和最近运行记录首版。后续重点是更完整的 Skill / Tool 导入、版本管理和团队共享。

目标：

- UI 添加 Skill。
- Skill 模板。
- Skill 文件夹管理。
- Skill 校验与配置诊断。

验收：

- 用户无需手写复杂 settings，也能添加 Skill。

### Phase 7：发布准备

状态：已完成中文 README、CHANGELOG、LICENSE、`.vscodeignore`、`vscode:prepublish`、本地 `.vsix` 打包脚本、发布清单和贡献指南；`patchlane-0.0.1.vsix` 已可本地生成。后续剩余截图、图标最终版、真实 GitHub 仓库地址和 Release 页面。

目标：

- 中文 README
- CHANGELOG
- LICENSE
- 图标和截图
- `.vscodeignore`
- `.vsix` 打包
- GitHub 仓库结构整理

验收：

- 能本地生成 `.vsix`。
- GitHub 首页说明完整。

## 12. 优先实现清单

下一批建议按这个顺序做：

1. 新增 Web 搜索配置和密钥存储。
2. 实现 `WebSearchService` 和 `web.search` / `web.fetch`。
3. 在工具选择器里加入“联网搜索”。
4. Agent 任务中允许调用 Web 搜索，并把结果显示到进度流。
5. 引入 Agent Orchestrator，把一次性 patch 改造成工具循环。
6. 接入验证命令自动修复。
7. 再做完整 MCP Client。

## 13. 产品原则

- 普通用户优先：少配置、少术语、默认可用。
- 高级用户可扩展：模型、工具、Skill、MCP、搜索服务都能换。
- 安全默认：网络、命令、写文件都可审查。
- 中文体验优先：界面、错误、文档、引导默认中文。
- 产出质量优先：Agent 必须能查资料、读代码、验证、修复，而不是只输出一大段回答。

## 14. 工程化 Agent 强化路线

目标：把 Patchlane 从“能生成可审查 diff 的插件”继续升级为“能低 token、高质量完成复杂工程任务的编程 Agent”。

### P0：上下文召回和工具定位

- 状态：已落地首版。
- 轻量代码地图：为工作区生成 source/config/test/docs/manifest 角色、主要符号、导入导出和 package scripts 摘要。
- 代码文本搜索工具：Agent 工具循环支持 `search_text`，先搜索符号、错误关键词、路由和调用点，再读取少量关键文件。
- 上下文注入策略：代码地图进入 Agent 准备上下文，作为候选文件之外的低 token 项目结构摘要。
- 验收：复杂任务中 Agent 可以先搜索定位，再读文件；不会只依赖打开文件和文件名猜测。

### P1：复杂任务拆解和检查点

- 状态：已升级为多 diff 分阶段执行首版。复杂任务会基于计划 checkpoint 建立阶段状态，每个阶段单独生成可审查 diff；应用和验证通过后推进下一阶段，失败时停留在当前阶段并支持续跑。
- 任务图：为大任务生成子任务、目标文件、依赖顺序、验收标准和验证命令。
- 分段执行：每个子任务生成一个可审查 diff，完成后写入 staged task phase。
- 失败续跑：验证或 patch 应用失败时，只回到当前子任务，不重做全部上下文；UI 可看到当前阶段、完成数、失败原因和续跑按钮。
- 验收：多文件复杂任务可以分阶段完成，用户能看到每个阶段的状态和可审查修改。

### P1：按影响范围验证

- 状态：已落地首版。
- 根据改动文件推断最小验证命令：相关测试、typecheck、lint affected files。
- 失败后再升级到全量验证，减少无关失败和执行时间。
- 验证输出结构化摘要：失败测试、文件行号、首个堆栈、关键错误码。
- 验收：小改动默认只跑必要验证，失败摘要能直接进入修复提示。

### P2：工具结果压缩和项目记忆

- 状态：已落地搜索输出压缩、验证输出压缩和 Repo Profile 项目画像缓存首版；失败样本记忆后续实施。
- 工具输出结构化压缩：搜索、验证、命令、MCP 输出按类型提取事实，而不是纯字符截断。
- Repo Profile 缓存：缓存技术栈、入口、目录职责、测试框架和常用命令，后续任务增量更新并注入 Agent 上下文。
- 失败样本记忆：记录验证失败类型、最终成功修复和相关文件，用于同类任务召回。
- 验收：重复任务消耗更少 token，失败修复不需要反复重新发现项目结构。

### P2：质量和风险控制

- 状态：已落地计划文件范围偏差检测、阶段范围检测、变更风险分级和高风险验证/检查点质量门禁首版。
- 计划偏差检测：比较计划文件、实际变更文件、验收标准和 patch 内容；计划外文件会进入质量审查，严重偏离时触发修复草稿流程。
- 变更风险分级：低风险文案/样式、中风险单模块逻辑、高风险跨模块 API/认证/数据迁移。
- 高风险任务强制更完整计划和验证：缺少具体验证或检查点时，质量审查失败并触发修复草稿流程。
- 验收：高风险修改不会在缺少影响面说明和验证计划时直接进入应用流程。

## 15. 当前执行状态补充（2026-05-23）

- 已完成：失败样本记忆首版。验证失败会记录命令、失败类型、摘要、关键错误行、关联文件和来源，并在后续 Agent 上下文与验证修复提示中按文件、命令和失败类型召回，避免同类问题反复重新定位。
- 已完成：联网搜索可信度与引用格式首版。搜索结果会标注 official/docs/github/news/community/unknown，生成 Citation 行，并在会话来源卡片、Agent 搜索上下文和提示词中保留来源、日期与可信度信息。
- 已完成：真正多 diff 分阶段执行首版。复杂任务会根据计划检查点建立 staged task，当前阶段单独生成 diff；应用成功并验证通过后自动生成下一阶段草稿，验证/应用失败则标记当前阶段失败并允许续跑当前阶段。
- 已完成：内置工程化 Skill / Tool 能力增强。新增工程化计划、重构迁移、质量门禁、任务编排、仓库地图、失败记忆等内置能力，并把选择结果注入 Agent 上下文和工具计划约束。
- 已完成：P0、P1、P2 中可以通过本地代码落地的工程化增强，包括代码地图、search_text、作用域验证、验证输出压缩、Repo Profile、风险分级、检查点、分阶段多 diff、阶段失败续跑、高风险质量门禁、失败样本记忆和搜索引用可信度。
- 外部交付依赖：Phase 7 的截图、最终图标、真实 GitHub 仓库/Release 页面需要人工素材确认与平台发布操作，不能在本地代码仓库中伪造完成。
