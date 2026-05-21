# Patchlane

Patchlane 是一个面向中文开发者的 VS Code AI 编程 Agent 插件。它不是单纯聊天窗口，而是把“对话、工作区上下文、可审批工具、联网搜索、可审查 diff、验证命令”放在同一个工程工作流里。

## 核心能力

- 中文优先界面和提示。
- DeepSeek 优先接入，同时支持 OpenAI、Claude、豆包、文心、通义千问、混元、GLM、星火、Ollama、LM Studio 和自定义接口。
- Chat 模式用于解释、问答、分析。
- Agent 模式用于真实工程任务：分析上下文、模型驱动调用工具、联网搜索、生成可确认修改。
- 所有文件写入都先生成 unified diff，确认后才写入工作区。
- 修改结果独立显示，支持实时查看生成中的 diff、应用、部分应用、放弃、撤回。
- 工具、Skill、MCP、命令、联网搜索都走页面内审批。
- 会话历史按工作区持久化，关闭聊天标签页不会丢失已有上下文。
- 当你先在 Chat 里生成计划，再切到 Agent 说“继续”或“按计划实现”时，Patchlane 会提取前文计划作为独立上下文，避免只靠普通聊天历史导致偏离任务。
- 如果 VS Code 窗口关闭或扩展主机重启，运行中的进程无法继续；Patchlane 会把遗留运行态标记为中断，并在对话里显示“重试上次请求”恢复卡片。
- 支持选中代码解释、文件引用、Markdown 渲染、代码高亮和复制 Markdown 源码。

## 安装调试

```bash
npm install
npm run compile
```

然后在 VS Code 中打开本项目目录，按 `F5` 启动 Extension Development Host。

在新打开的 VS Code 窗口中：

1. 点击左侧活动栏的 `Patchlane`。
2. 侧边栏会先显示当前工作区的历史会话。
3. 点击“新建会话”或已有会话，会在编辑区右侧打开 Patchlane 对话页。
4. 底部选择模型并填写对应 API Key。

如果开发窗口空白，先确认执行过：

```bash
npm run compile
```

## 运行测试

```bash
npm test
```

`npm test` 会先编译扩展和 Webview，再运行基础 patch 测试。

## 打包安装

生成本地安装包：

```bash
npm run package:vsix
```

命令会先执行 `vscode:prepublish` 编译扩展和 Webview，然后在项目根目录生成 `patchlane-0.0.1.vsix`。

本地安装：

```bash
code --install-extension patchlane-0.0.1.vsix
```

如果已经安装过旧版本，可以先在 VS Code 扩展面板卸载旧版，或者执行安装命令后重启 VS Code。

发布前检查见 `docs/RELEASE.md`，开发和贡献流程见 `docs/CONTRIBUTING.md`。创建真实 GitHub 仓库后，可以再把这些路径换成仓库链接。

## 模型配置

普通用户只需要做两件事：

1. 在底部模型选择器里选择模型。
2. 点击 `API Key` 填写对应厂商密钥。

自定义模型入口：

- 命令面板：`Patchlane: 配置自定义模型`
- 设置页：点击“配置自定义模型”

自定义接口支持：

- OpenAI 兼容协议：`/chat/completions`，GPT-5 / o 系列会自动走 `/responses`。
- Claude / Anthropic 兼容协议：`/messages`。

API Key 使用 VS Code SecretStorage 本地保存，不写入 settings.json。

## 质量和 Token 成本

Patchlane 默认使用“均衡”上下文预算：先在本地筛选当前文件、已打开文件、显式引用文件和高相关候选文件，再把少量关键内容交给模型。这样既避免把整个项目塞进上下文，也能保留工程质量。

可在设置里调整：

```json
{
  "codeAgent.agent.contextBudget": "balanced"
}
```

可选值：

- `economy`：省 token，少读文件、少带历史，适合小修小改和低成本模型。
- `balanced`：默认档位，质量和成本均衡。
- `quality`：扩大上下文预算，适合复杂重构、多文件任务和高能力模型。

预算会统一影响候选文件数、读取文件数、文件片段长度、历史会话长度、联网搜索摘录、工具输出和验证输出。Agent 会优先用本地排序、去重、截断和计划约束来节省算力。

长文件不会再只保留开头：Patchlane 会保留文件头部和尾部，并在中间标记截断。复杂页面或多文件任务建议切到 `quality`，或者用底部“+ 引用文件”显式选择关键文件，避免模型只看到片段后生成不完整 patch。

如果当前请求是“继续”“按上面的计划实现”“逐一完成所有任务”这类延续任务，Patchlane 会从同一会话前文提取计划、步骤、文件范围和验收标准，单独压缩成 Agent 记忆块。这样比把完整聊天历史塞给模型更省 token，也能减少模型重新生成无关示例项目的概率。

还可以控制 Agent 的工具循环轮次：

```json
{
  "codeAgent.agent.maxToolRounds": 2
}
```

轮次越高，Agent 越可能补充读取文件、搜索资料或运行验证；同时会增加 token 和调用成本。

## Chat 与 Agent

Chat 模式：

- 只回答问题。
- 适合解释代码、分析报错、讨论方案。
- 不会直接修改文件。

Agent 模式：

- 适合“帮我实现/修复/重构/补测试”这类工程任务。
- 会先做本地只读分析：当前文件、已打开标签页、候选文件、诊断、Git 状态。
- 生成修改前会进行模型驱动工具循环：按少量轮次决定是否读取文件、联网搜索、运行已选 Skill/MCP 或验证命令。
- 如果当前任务引用前文计划，会优先继承同一会话中的计划摘录，再结合真实工作区上下文生成 diff。
- 工具循环默认最多 2 轮，优先少读、少搜、少跑命令，避免把整个工作区塞进上下文。
- 最终生成可审查 diff，用户确认后才写入。

输入框快捷键：

- `Enter` 发送。
- `Ctrl+Enter` 换行。
- `+` 引用文件，当前打开文件和已打开标签页优先显示。
- `Skill` 选择内置或自定义工作流。
- `MCP` 选择工具或 MCP 能力。
- `搜索` 对当前输入执行联网搜索。

## 修改结果工作流

Agent 生成修改后，切换到“修改结果”页查看：

- 涉及文件列表
- 增删行统计
- 实时 diff
- 执行计划
- 质量审查
- 应用修改
- 部分应用
- 放弃草稿
- 撤回上次修改
- 运行验证
- 验证并修复

运行验证使用配置项：

```json
{
  "codeAgent.verify.commands": ["npm test"]
}
```

如果没有手动配置验证命令，Patchlane 会按当前工作区自动推荐验证套件：优先识别 `package.json` 中的 `typecheck`、`test`、`lint`、`build` 脚本，并按 lockfile 选择 `npm`、`pnpm`、`yarn` 或 `bun`；也会识别 Go、Rust 和 Python 项目的常见验证命令。

验证命令会按配置或自动推荐顺序形成验证套件，逐条在页面内请求审批。Patchlane 默认失败即停止，并把失败类型归类为类型检查、测试、Lint、构建、依赖缺失、运行时错误等。输出会记录到当前会话里。“验证并修复”会在验证失败时自动生成新的修复草稿，仍然需要你审查 diff 并手动应用。

从修改结果页点击“应用修改”后，Patchlane 会复用页面内审批直接写入文件，不再额外弹 VS Code 确认框。应用完成后如果配置了验证命令，会自动请求运行验证；验证失败时会继续生成下一轮可审查修复草稿，直到验证通过、手动停止，或达到 `codeAgent.agent.maxRepairAttempts` 上限。

修改结果页会标记修复草稿来自手动验证还是应用后验证，并显示当前第几轮、失败命令、失败类型和摘要。Patchlane 不会自动应用下一轮修复草稿，避免模型输出绕过人工确认直接写入工作区。

如果应用失败，Patchlane 会重新读取失败 patch 涉及的文件当前内容，再生成修复草稿。质量审查为“未通过”的草稿不会允许直接应用，需要先让 Agent 修复或重新生成。

Patchlane 会把常见失败归因为下一步策略，再注入修复提示中：

- 模型空响应：建议拆小任务、减少上下文、调大输出上限或切换非思考模型。
- Patch 截断：缩小到更少文件，只输出 unified diff。
- 应用冲突：以当前文件内容为准重建 hunk，不照抄旧 patch。
- 验证失败：按类型检查、测试、Lint、构建、依赖缺失、运行时错误等分类收窄修复范围。

这些策略用于减少盲目重试和无关大改，所有修复仍然只会生成可审查 diff，不会自动写入。

如果模型没有返回可用内容，例如 API Key 未配置、只返回思考内容、上下文过长、限流、网络失败或服务端错误，Patchlane 会把错误归因为中文可行动提示。即使模型完全没有输出 diff，修改结果页也会保留失败状态和质量审查说明，方便你判断是重试、换模型、调大 `max_tokens`，还是拆小任务。

## 联网搜索

联网搜索默认关闭。可通过设置页或命令面板启用：

```text
Patchlane: 配置联网搜索
```

支持搜索后端：

- 免费搜索（无需 Key）：默认优先尝试 Bing HTML、百度、搜狗、DuckDuckGo HTML，再轮询公开 SearXNG 实例，并会尝试从 SearX Space 获取当前公开实例列表。
- SearXNG：推荐团队或个人自建，仍然不需要 API Key。
- Tavily、Brave Search、Bing Web Search、SerpAPI：需要填写对应服务的 API Key。
- 自定义搜索 API：适合接入公司内部搜索网关或兼容 `q` / `num` 参数的接口。

公开搜索页面和 SearXNG 实例都不保证稳定，可能限流、屏蔽部分网络、返回验证码或关闭搜索接口。普通用户可以先选“免费搜索（无需 Key）”；如果需要稳定性，建议自建 SearXNG 并把地址填到 Base URL。

配置项示例：

```json
{
  "codeAgent.webSearch.enabled": true,
  "codeAgent.webSearch.provider": "free",
  "codeAgent.webSearch.baseUrl": "",
  "codeAgent.webSearch.maxResults": 6,
  "codeAgent.webSearch.defaultRecencyDays": 30,
  "codeAgent.webSearch.allowedDomains": [],
  "codeAgent.webSearch.blockedDomains": [],
  "codeAgent.webSearch.requireApproval": true
}
```

如果你有自建 SearXNG，可以这样配置，依然不需要 Key：

```json
{
  "codeAgent.webSearch.enabled": true,
  "codeAgent.webSearch.provider": "searxng",
  "codeAgent.webSearch.baseUrl": "https://your-searxng.example.com"
}
```

使用方式：

- 输入 `/web React 19 官方文档`。
- 输入 `/docs VS Code Webview Markdown 渲染`，优先搜索官方文档。
- 输入 `/github modelcontextprotocol typescript sdk issue`，优先搜索 GitHub 仓库、Issue 和 Release。
- 输入 `/news qwen coder changelog`，优先搜索近期 Release、Changelog 和公告。
- 点击输入框下方“搜索”。
- Agent 模式选择“联网搜索”工具。
- 当任务涉及最新文档、Release、SDK、依赖版本或报错时，Agent 会优先尝试搜索。
- 搜索结果卡片支持“读取正文”，审批后会把网页正文摘录加入当前会话上下文。

搜索前会在页面内显示审批卡片，包含查询词、服务商和域名限制。

## Skill 与 MCP 扩展

Patchlane 的 Skill 是可复用工作流，不只是提示词。它可以绑定脚本、模板和工具。MCP 已支持 stdio Client、HTTP JSON-RPC 和 `text/event-stream` SSE 响应：可以启动或连接 MCP Server、调用 `tools/list` 发现工具，并在审批后调用 `tools/call`。设置页也能发现 `resources/list` 和 `prompts/list`，并通过页面内审批读取 `resources/read` 或获取 `prompts/get`，结果会进入当前会话上下文。

普通代码任务可以先不配置 Skill / MCP。内置的代码审查、调试分析、测试生成、文件读写、终端命令和联网搜索已经能直接在输入框底部选择；只有要接团队脚本、业务系统、外部 MCP 服务时，才需要继续扩展。

普通用户可以先在设置页使用两个入口：

- “生成扩展模板”：一次性创建 `.patchlane/skills`、`.patchlane/tools`、`.patchlane/mcp` 示例，并写入工作区设置。
- “创建一个 Skill”：填写名称、说明和运行时，Patchlane 会生成 `.patchlane/skills/<id>/index.*` 并自动加入 `codeAgent.customSkills`。
- 团队共享能力推荐写入 `.patchlane/patchlane.json`。这个文件可以提交到 Git，团队成员打开同一个仓库后会自动看到同一批 Skill、Tool 和 MCP 服务。

推荐目录：

```text
.patchlane/
  patchlane.json
  skills/
    frontend-review/
      index.js
  tools/
    jira/
      index.js
  mcp/
    filesystem/
      server.js
```

`.patchlane/patchlane.json` 示例：

```json
{
  "version": "1.0.0",
  "skills": [
    {
      "id": "frontend-review",
      "label": "前端体验审查",
      "description": "检查布局、响应式、可访问性和交互细节",
      "kind": "custom",
      "runtime": "node",
      "script": ".patchlane/skills/frontend-review/index.js"
    }
  ],
  "tools": [
    {
      "id": "project-summary",
      "label": "项目摘要",
      "description": "快速读取项目说明和脚本，给 Agent 提供轻量上下文",
      "kind": "custom",
      "runtime": "node",
      "script": ".patchlane/tools/project-summary/index.js"
    }
  ],
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "node",
      "args": [".patchlane/mcp/filesystem/server.js"],
      "cwd": "${workspaceFolder}",
      "tools": [
        {
          "name": "read_file",
          "label": "读取文件",
          "description": "通过 MCP 文件系统服务读取文件"
        }
      ]
    }
  }
}
```

个人临时能力也可以继续在 VS Code `settings.json` 中添加：

```json
{
  "codeAgent.customSkills": [
    {
      "id": "frontend-review",
      "label": "前端体验审查",
      "description": "检查布局、响应式、可访问性和交互细节",
      "runtime": "node",
      "script": ".patchlane/skills/frontend-review/index.js"
    }
  ],
  "codeAgent.customTools": [
    {
      "id": "jira",
      "label": "Jira 需求",
      "description": "读取需求单内容作为任务上下文",
      "kind": "custom",
      "runtime": "node",
      "script": ".patchlane/tools/jira/index.js"
    },
    {
      "id": "filesystem-mcp",
      "label": "文件系统 MCP",
      "description": "连接本地文件系统 MCP 工具",
      "kind": "mcp",
      "server": "filesystem",
      "runtime": "node",
      "script": ".patchlane/mcp/filesystem/server.js",
      "args": ["--workspace", "${workspaceFolder}"]
    }
  ]
}
```

同一个 ID 同时出现在 `.patchlane/patchlane.json` 和 VS Code settings 时，settings 优先生效，方便个人覆盖团队默认配置。清单解析错误、缺字段、重复 ID 或不安全脚本路径会显示在设置页“配置诊断”里，不会静默失败。

stdio MCP Client 配置示例：

```json
{
  "codeAgent.mcp.servers": {
    "filesystem": {
      "transport": "stdio",
      "command": "node",
      "args": [".patchlane/mcp/filesystem/server.js"],
      "cwd": "${workspaceFolder}",
      "tools": [
        {
          "name": "read_file",
          "label": "读取文件",
          "description": "通过 MCP 文件系统服务读取文件"
        }
      ]
    }
  }
}
```

HTTP MCP 配置示例：

```json
{
  "codeAgent.mcp.servers": {
    "remote-tools": {
      "transport": "http",
      "url": "https://your-mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer your-token"
      },
      "tools": [
        {
          "name": "search_docs",
          "label": "搜索内部文档",
          "description": "通过远程 MCP 搜索团队文档"
        }
      ]
    }
  }
}
```

配置后有两种使用方式：

- 在设置页点击“发现 MCP 能力”，Patchlane 会启动 stdio MCP Server 或连接 HTTP MCP，并读取 `tools/list`、`resources/list`、`prompts/list`。
- 发现到的工具会自动出现在输入框下方的 MCP 选择器里；资源和 Prompt 会显示在设置页的 MCP 目录里，可点击“读取”或“使用”。
- 如果 MCP Prompt 声明了参数，设置页会直接显示参数输入框；必填参数填完后才能使用。
- MCP 服务卡片会显示运行状态、最近日志、错误信息，并支持页面内审批后的“重连”“停止”“清空日志”。
- 也可以手动写 `tools`，这样不发现也能显示。

点击标签上的运行按钮或在 Agent 模式中选择该 MCP 工具时，当前任务会作为参数传入：

- 如果输入是 JSON 对象，会作为 MCP tool arguments。
- 如果输入不是 JSON，会作为 `{ "input": "你的输入" }`。
- HTTP MCP 支持普通 JSON 响应，也能读取 `text/event-stream` SSE 响应并按 JSON-RPC id 匹配当前请求。
- HTTP MCP 的 JSON-RPC 和 SSE 解析已抽成独立解析模块，并覆盖 plain JSON、批量响应、多事件 SSE、多行 `data:` 和 `[DONE]` 等回归场景。

Agent 模式中，已选择的脚本 Skill、脚本工具和具体 MCP 工具会在生成修改前执行，执行输出会合并进模型上下文。通用占位工具例如“文件读写”“MCP 工具”只表示能力开关，不会被当成具体命令执行。

在设置页的扩展能力工作台中，自定义 Skill、脚本工具和 MCP 工具支持：

- “打开”：直接打开脚本文件，方便查看或修改。
- “测试”：用一段测试输入运行该能力，执行前仍会显示页面内审批卡片。
- “最近运行”：记录当前会话里手动测试和 Agent 自动调用的 Skill、工具、MCP，包括状态、退出码、命令和输出摘要，方便判断扩展能力是否真的被执行。

设置页会显示“配置诊断”，用于检查常见问题。诊断卡片会直接给出处理建议，并提供“打开设置”或“打开清单”按钮：

| 诊断内容 | 处理方式 |
| --- | --- |
| MCP 服务缺少 `command` | 这是 stdio MCP。填写启动命令，例如 `node` 或 `python`，再用 `args` 指向服务脚本。 |
| MCP 服务缺少 `url` | 这是 HTTP MCP。填写 MCP JSON-RPC 地址，例如 `https://your-server.example.com/mcp`。 |
| MCP 工具缺少 `server` 或 `command` | `server` 填 MCP 服务名，`command` 填 MCP 工具名。普通用户也可以先点“生成扩展模板”参考示例。 |
| MCP 服务启动失败 | 先在 MCP 服务卡片点“重连”；仍失败时检查 `command`、`args`、`cwd`、`env` 或远程 URL。 |
| 已配置但未发现能力 | 点“发现 MCP 能力”；如果仍为空，确认 MCP Server 是否实现 `tools/list`、`resources/list` 或 `prompts/list`。 |
| Skill / 工具 ID 重复 | 修改为唯一 `id`。同一个 ID 只会命中其中一个能力。 |
| `.patchlane/patchlane.json` 清单异常 | 点“打开清单”，按提示修正 JSON、字段类型或必填字段。 |
| 脚本路径不安全 | 把脚本移动到当前工作区内，推荐 `.patchlane/skills`、`.patchlane/tools` 或 `.patchlane/mcp`。 |
| 工具没有可执行入口 | 如果只是提示标签，改成 Skill；如果要让 Agent 执行它，填写 `script` 或 `command`。 |

审批策略：

- 选择 Skill 或 MCP 不会立刻请求审批。
- 真正执行脚本、命令、联网搜索、文件读取或文件写入前才会审批。
- 同一会话同一 Skill 或工具审批一次即可。
- 命令默认每次审批，也可以在当前会话记住完全相同的命令。

## 计划路线

当前已完成：

- 中文 UI
- 多模型选择
- SecretStorage 密钥
- Chat 流式输出和停止
- Agent 可确认 diff
- 修改结果页
- 页面内审批
- 文件引用
- Skill / MCP 脚本入口
- stdio MCP Client 首版
- HTTP MCP JSON-RPC 和 SSE 响应兼容
- MCP 资源读取和 MCP Prompt 获取
- MCP Prompt 参数表单
- 设置页创建 Skill
- MCP 服务重连、停止和最近日志
- Skill / 工具工作台打开脚本和测试运行
- Skill / 工具 / MCP 最近运行记录
- 任务中断恢复卡片和一键重试
- Skill / Tool / MCP 配置诊断
- 联网搜索
- 官方文档 / GitHub / 最新消息优先搜索
- 第一版本地 Agent 编排器
- 会话内多命令验证套件
- 验证命令自动发现
- 验证失败后生成修复草稿
- 长文件上下文头尾保留，减少关键代码被截断
- “继续 / 按计划实现”会提取前文计划作为 Agent 记忆，减少任务偏离和 token 浪费
- 应用失败后按失败 patch 涉及文件重新读取当前内容并生成修复草稿
- 质量审查未通过时禁用直接应用，避免不完整 patch 写入工作区
- 模型失败归因已统一为中文提示，空响应也会在修改结果页保留失败状态
- MCP HTTP/SSE 解析已补回归测试
- 本地 `.vsix` 打包和发布清单

下一步重点：

- 更完整的 Agent 自主循环和计划动态修正
- 更强的任务级失败归因和动态计划修正
- Skill / MCP 管理体验增强
- 截图、图标最终版和 GitHub Release 页面
