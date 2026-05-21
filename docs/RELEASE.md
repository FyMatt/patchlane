# Patchlane 发布清单

本文件用于本地打包、安装验证和后续 GitHub Release 准备。

## 发布前检查

1. 确认 `README.md`、`CHANGELOG.md`、`LICENSE` 已更新。
2. 确认 `package.json` 里的 `version`、`displayName`、`description` 正确。
3. 运行测试：

```bash
npm test
```

4. 生成 VSIX：

```bash
npm run package:vsix
```

5. 确认根目录生成：

```text
patchlane-0.0.1.vsix
```

## 本地安装验证

```bash
code --install-extension patchlane-0.0.1.vsix
```

安装后重启 VS Code，打开任意工作区，检查：

- 左侧活动栏显示 Patchlane。
- 可以新建会话。
- 底部可以选择模型并设置 API Key。
- Chat 模式可以正常流式回复。
- Agent 模式会生成“修改结果”草稿，而不是直接写文件。
- 应用修改前会出现页面内审批。
- Skill / MCP / 联网搜索 / 验证命令执行前会出现页面内审批。

## 发布包内容

`.vscodeignore` 已排除源码、调试配置、测试产物、sourcemap、旧 `.vsix` 和构建配置。VSIX 应主要包含：

- `dist/`
- `media/`
- `package.json`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`

## GitHub Release 准备

创建真实 GitHub 仓库后再补充 `package.json` 的 `repository` 字段。不要填假地址。

建议 Release 内容：

- 标题：`Patchlane 0.0.1`
- 附件：`patchlane-0.0.1.vsix`
- 说明：复制 `CHANGELOG.md` 中 `0.0.1` 的内容，并补充安装命令。

## 常见问题

如果 `vsce package` 提示缺少 repository，当前脚本已使用 `--allow-missing-repository`。上线公开仓库后应补充真实仓库地址，再移除该参数。

如果打包产物异常变大，先检查 `.vscodeignore` 是否误删或失效，尤其是：

- `**/*.map`
- `dist/test/**`
- `dist/webview/**`
- `node_modules`
- `src`
