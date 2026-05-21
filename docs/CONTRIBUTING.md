# Patchlane 贡献指南

Patchlane 是中文优先的 VS Code 工程 Agent。贡献代码时优先保证安全、可审查、可停止和可回滚。

## 开发环境

```bash
npm install
npm run compile
```

在 VS Code 中按 `F5` 启动 Extension Development Host。

## 常用命令

```bash
npm run compile
npm test
npm run package:vsix
```

- `compile`：编译扩展和 Webview。
- `test`：编译后运行基础测试。
- `package:vsix`：生成本地安装包。

## 代码结构

```text
src/
  extension.ts              扩展入口和命令注册
  config.ts                 配置、模型、能力和 MCP 设置
  providers/                模型供应商适配
  services/                 Agent、审批、Patch、MCP、搜索、验证等核心服务
  views/chatViewProvider.ts VS Code Webview 通信和工作流编排
  webview/                  React Webview UI 源码
media/webview/              Webview 打包产物
docs/                       发布和贡献文档
```

## 贡献原则

- 所有面向用户的界面、错误、说明默认使用简体中文。
- Agent 写文件必须先生成可审查 diff，不能绕过确认直接写入。
- 命令、脚本、Skill、MCP、联网搜索、文件写入必须走审批。
- 长输出要压缩，不要把整个项目或完整日志直接塞给模型。
- 新功能优先接入进度流、停止按钮和会话持久化。
- Webview 改动要同时考虑深色/浅色主题、小宽度侧栏和代码块可读性。

## 添加模型供应商

优先使用 OpenAI 兼容接口：

1. 在 `src/config.ts` 增加 provider、baseUrl 和模型选项。
2. 在 `src/extension.ts` 注册 provider。
3. 在 `package.json` 增加设置项。
4. 在 README 中补充说明。

API Key 必须使用 VS Code SecretStorage，不要写入 settings.json。

## 添加 Skill / Tool / MCP

普通用户推荐使用设置页生成模板。团队共享能力优先写入 `.patchlane/patchlane.json`，脚本放在 `.patchlane/skills`、`.patchlane/tools` 或 `.patchlane/mcp` 下；个人临时能力再写入 VS Code settings。

手动贡献内置能力时：

1. 在 `src/config.ts` 增加能力定义。
2. 如果能力可执行，接入 `CapabilityRunner`。
3. 如果能力来自 MCP，确保 `server` 和 `command` 可解析。
4. 在设置页和运行记录中能看到执行状态。

脚本能力必须支持审批和停止信号。

涉及 Agent 失败恢复时：

- 模型调用、patch 质量、应用失败、验证失败要尽量归因为可行动策略。
- 新增失败类型优先补到 `agentFailureStrategy.ts`，并写测试覆盖。
- 修复提示必须保持“最小修改、可审查 diff、人工确认后写入”的安全边界。

## 测试要求

每次提交前至少运行：

```bash
npm test
```

涉及 Webview UI 的改动还需要手动验证：

- 会话列表能打开。
- 对话消息可滚动。
- Markdown 和代码块渲染正常。
- 修改结果页可实时显示 diff。
- 停止按钮能中断正在运行的任务。

## 发布

按 `docs/RELEASE.md` 执行。
