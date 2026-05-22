export interface ScopedVerifyPlan {
  commands: string[];
  reason: string;
  scoped: boolean;
}

export function buildScopedVerifyPlan(commands: string[], changedFiles: string[] = []): ScopedVerifyPlan {
  if (commands.length === 0) {
    return {
      commands: [],
      reason: "没有可用验证命令。",
      scoped: false
    };
  }

  const normalizedFiles = changedFiles.map((file) => file.replace(/\\/g, "/").toLowerCase());
  if (normalizedFiles.length === 0) {
    return {
      commands,
      reason: "未提供变更文件，使用完整验证套件。",
      scoped: false
    };
  }

  const isDocsOnly = normalizedFiles.every((file) => /\.(md|mdx|txt|rst)$/.test(file) || /(^|\/)(docs?|changelog|license)(\/|$)/.test(file));
  if (isDocsOnly) {
    const lintCommands = commands.filter((command) => /lint|prettier|format/i.test(command));
    return {
      commands: lintCommands.length > 0 ? lintCommands : commands.slice(0, 1),
      reason: "变更主要是文档，优先运行格式或最小验证。",
      scoped: true
    };
  }

  const touchesRuntimeCode = normalizedFiles.some((file) => /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|cs|php|rb)$/.test(file));
  const touchesTests = normalizedFiles.some((file) => /(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./.test(file));
  const touchesConfig = normalizedFiles.some((file) => /package\.json$|tsconfig|vite\.config|webpack|rollup|eslint|prettier|jest|vitest|playwright|pyproject|cargo\.toml|go\.mod/.test(file));

  const selected = commands.filter((command) => {
    const lower = command.toLowerCase();
    if (touchesConfig) {
      return /typecheck|test|lint|build|check|tsc|pytest|cargo test|go test/.test(lower);
    }
    if (touchesTests) {
      return /test|vitest|jest|pytest|cargo test|go test|playwright|cypress/.test(lower);
    }
    if (touchesRuntimeCode) {
      return /typecheck|test|lint|tsc|check/.test(lower);
    }
    return /lint|test|typecheck|check/.test(lower);
  });

  if (selected.length === 0 || selected.length === commands.length) {
    return {
      commands,
      reason: "变更影响范围较广，使用完整验证套件。",
      scoped: false
    };
  }

  return {
    commands: selected,
    reason: `根据 ${normalizedFiles.slice(0, 6).join("、")} 选择最小相关验证。`,
    scoped: true
  };
}
