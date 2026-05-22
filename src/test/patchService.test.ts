import * as assert from "assert";
import {
  createFailureStrategyFromApplyError,
  createFailureStrategyFromProviderMessage,
  createFailureStrategyFromQuality,
  createFailureStrategyFromVerify,
  formatFailureStrategyForPrompt
} from "../services/agentFailureStrategy";
import { buildAgentMemoryContext, extractPreviousPlanBlock, shouldFollowPlan } from "../services/agentMemory";
import { compactText, normalizeToolPlan, parsePlannerJson } from "../services/agentToolPlan";
import { parseCapabilityManifestJson } from "../services/capabilityManifest";
import { buildFailureMemoryRecord, FailureMemoryStore, formatFailureMemoryForPrompt, selectRelevantFailureMemory } from "../services/failureMemory";
import { parseGitStatus } from "../services/gitStatusParser";
import { filterPatchHunks, getHunkChoices } from "../services/hunkSelector";
import { parseHttpMcpPayload, readSseJsonRpcResponse } from "../services/mcpHttpParser";
import { buildPlanRiskChecks, PatchQualityPlan } from "../services/patchQualityRules";
import { inferPatchRiskLevel, normalizePatchRiskLevel } from "../services/patchRisk";
import { buildRepoProfile, formatRepoProfileForPrompt } from "../services/repoProfile";
import {
  advanceStagedTask,
  buildStagedPhaseRequest,
  createDraftStageInfo,
  createPhasePatchPlan,
  createStagedTaskState,
  markCurrentPhaseDone,
  markCurrentPhaseDraftReady,
  markCurrentPhaseFailed,
  shouldUseStagedExecution
} from "../services/stagedTaskPlan";
import { applyPatchToText, extractUnifiedDiff, parseUnifiedDiff } from "../services/unifiedDiff";
import { doesSearchProviderNeedApiKey, getFreeSearchBaseUrls, webSearchProviderLabel } from "../services/webSearchDefaults";
import { formatWebSearchError } from "../services/webSearchErrors";
import { classifyWebSearchTrust, formatWebSearchCitation } from "../services/webSearchTrust";
import {
  parseBaiduHtmlResults,
  parseBingHtmlResults,
  parseDuckDuckGoHtmlResults,
  parseSearxngHtmlResults,
  parseSogouHtmlResults
} from "../services/webSearchParsing";
import { rankAndFilterSearchResults } from "../services/webSearchRelevance";
import { buildScopedVerifyPlan } from "../services/verifyPlanner";
import { createEmptyResponseError, createMissingApiKeyError, createRequestError, formatProviderErrorForUser } from "../providers/errors";

function firstPatch(diff: string) {
  const parsed = parseUnifiedDiff(diff);
  assert.strictEqual(parsed.files.length, 1);
  return parsed.files[0];
}

function testModifyPatch(): void {
  const diff = [
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1,3 +1,3 @@",
    " alpha",
    "-beta",
    "+bravo",
    " gamma"
  ].join("\n");

  const result = applyPatchToText("alpha\nbeta\ngamma\n", firstPatch(diff), "example.txt", false);
  assert.strictEqual(result, "alpha\nbravo\ngamma\n");
}

function testCreatePatch(): void {
  const diff = [
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+one",
    "+two"
  ].join("\n");

  const result = applyPatchToText("", firstPatch(diff), "new.txt", true);
  assert.strictEqual(result, "one\ntwo\n");
}

function testUnsafePath(): void {
  const diff = [
    "--- a/src/../../outside.txt",
    "+++ b/src/../../outside.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new"
  ].join("\n");

  assert.throws(() => parseUnifiedDiff(diff), /Unsafe path/);
}

function testExtractsFencedDiff(): void {
  const raw = [
    "Here is the patch:",
    "```diff",
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "```"
  ].join("\n");

  assert.strictEqual(
    extractUnifiedDiff(raw),
    ["--- a/example.txt", "+++ b/example.txt", "@@ -1 +1 @@", "-old", "+new"].join("\n")
  );
}

function testContextMismatchThrowsDiagnosticError(): void {
  const diff = [
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1 +1 @@",
    "-expected",
    "+actual"
  ].join("\n");

  assert.throws(
    () => applyPatchToText("different\n", firstPatch(diff), "example.txt", false),
    /修改上下文不匹配/
  );
}

function testFilterPatchHunksKeepsSelectedHunkOnly(): void {
  const diff = [
    "--- a/example.txt",
    "+++ b/example.txt",
    "@@ -1 +1 @@",
    "-one",
    "+uno",
    "@@ -3 +3 @@",
    "-three",
    "+tres"
  ].join("\n");

  const choices = getHunkChoices(diff);
  assert.strictEqual(choices.length, 2);
  const filtered = filterPatchHunks(diff, [choices[1]]);
  assert.ok(filtered.includes("-three"));
  assert.ok(!filtered.includes("-one"));
}

function testParseGitStatusSnapshot(): void {
  const status = [
    "## feature/ui...origin/feature/ui [ahead 2, behind 1]",
    "M  src/staged.ts",
    " M src/unstaged.ts",
    "?? src/new.ts",
    "R  src/old.ts -> src/new-name.ts",
    "UU src/conflict.ts"
  ].join("\n");

  const parsed = parseGitStatus(status);
  assert.strictEqual(parsed.branch, "feature/ui");
  assert.strictEqual(parsed.upstream, "origin/feature/ui");
  assert.strictEqual(parsed.ahead, 2);
  assert.strictEqual(parsed.behind, 1);
  assert.strictEqual(parsed.staged, 3);
  assert.strictEqual(parsed.unstaged, 3);
  assert.strictEqual(parsed.untracked, 1);
  assert.strictEqual(parsed.conflicted, 1);
  assert.strictEqual(parsed.files[3].path, "src/new-name.ts");
  assert.strictEqual(parsed.files[3].originalPath, "src/old.ts");
}

function testToolPlanParsesFencedJson(): void {
  const parsed = parsePlannerJson([
    "```json",
    "{",
    '  "summary": "读取关键文件",',
    '  "actions": [{ "type": "read_file", "path": "@src/app.ts", "reason": "入口文件" }]',
    "}",
    "```"
  ].join("\n"));
  const plan = normalizeToolPlan(parsed, { skills: [], tools: [] });
  assert.strictEqual(plan.summary, "读取关键文件");
  assert.deepStrictEqual(plan.actions[0], { type: "read_file", path: "src/app.ts", reason: "入口文件" });
}

function testToolPlanFiltersInvalidAndDedupesActions(): void {
  const parsed = {
    actions: [
      { type: "run_capability", capabilityId: "missing" },
      { type: "run_capability", capabilityId: "review", input: "x" },
      { type: "run_capability", capabilityId: "review", input: "x" },
      { type: "search_text", query: " handleSubmit " },
      { type: "search_text", query: "handleSubmit" },
      { type: "web_search", query: " VS Code API " },
      { type: "web_search", query: "vs code api" }
    ]
  };
  const plan = normalizeToolPlan(parsed, {
    skills: [{ id: "review", label: "代码审查", description: "检查代码" }],
    tools: []
  });
  assert.strictEqual(plan.actions.length, 3);
  assert.deepStrictEqual(plan.actions[0], { type: "run_capability", capabilityId: "review", input: "x", reason: undefined });
  assert.deepStrictEqual(plan.actions[1], { type: "search_text", query: "handleSubmit", reason: undefined });
  assert.deepStrictEqual(plan.actions[2], { type: "web_search", query: "VS Code API", reason: undefined });
}

function testCompactTextKeepsHeadAndTail(): void {
  const text = "a".repeat(20) + "middle" + "z".repeat(20);
  const compacted = compactText(text, 20);
  assert.ok(compacted.includes("[已截断"));
  assert.ok(compacted.startsWith("aaaaaaaa"));
  assert.ok(compacted.endsWith("zzzzzz"));
}

function testScopedVerifyPlanPrefersRelevantCommands(): void {
  const commands = ["npm run typecheck", "npm test", "npm run lint", "npm run build"];

  const sourcePlan = buildScopedVerifyPlan(commands, ["src/app.ts"]);
  assert.deepStrictEqual(sourcePlan.commands, ["npm run typecheck", "npm test", "npm run lint"]);
  assert.strictEqual(sourcePlan.scoped, true);

  const docsPlan = buildScopedVerifyPlan(commands, ["docs/usage.md"]);
  assert.deepStrictEqual(docsPlan.commands, ["npm run lint"]);
  assert.strictEqual(docsPlan.scoped, true);
}

function testPatchRiskLevelInference(): void {
  assert.strictEqual(normalizePatchRiskLevel("medium"), "medium");
  assert.strictEqual(normalizePatchRiskLevel("unknown"), undefined);
  assert.strictEqual(inferPatchRiskLevel([{ path: "src/app.ts", operation: "modify" }]), "low");
  assert.strictEqual(inferPatchRiskLevel([
    { path: "src/app.ts", operation: "modify" },
    { path: "src/routes.ts", operation: "modify" }
  ]), "medium");
  assert.strictEqual(inferPatchRiskLevel([{ path: "src/auth/session.ts", operation: "modify" }]), "high");
  assert.strictEqual(inferPatchRiskLevel([{ path: "src/app.ts", operation: "delete" }]), "high");
  assert.strictEqual(inferPatchRiskLevel([{ path: "src/app.ts", operation: "modify" }], ["涉及数据库迁移"]), "high");
}

function testRepoProfileSummarizesCodeMap(): void {
  const profile = buildRepoProfile({
    packageScripts: ["test: vitest run", "typecheck: tsc -p ./"],
    files: [
      {
        path: "src/extension.ts",
        languageId: "typescript",
        lineCount: 120,
        symbols: ["activate"],
        imports: ["vscode"],
        exports: ["activate"],
        roles: ["source"]
      },
      {
        path: "src/app.test.ts",
        languageId: "typescript",
        lineCount: 40,
        symbols: [],
        imports: ["vitest"],
        exports: [],
        roles: ["test"]
      },
      {
        path: "package.json",
        languageId: "json",
        lineCount: 20,
        symbols: [],
        imports: [],
        exports: [],
        roles: ["manifest"]
      }
    ]
  }, new Date("2026-05-23T00:00:00.000Z"));

  assert.deepStrictEqual(profile.languages, ["typescript", "json"]);
  assert.deepStrictEqual(profile.entrypoints, ["src/extension.ts"]);
  assert.deepStrictEqual(profile.testFiles, ["src/app.test.ts"]);
  assert.ok(profile.testFrameworks.includes("vitest"));
  assert.ok(formatRepoProfileForPrompt(profile, 1000).includes("Repo profile:"));
}

async function testFailureMemoryStoresDedupesAndFormats(): Promise<void> {
  const backing = new Map<string, unknown>();
  const store = new FailureMemoryStore({
    get<T>(key: string, defaultValue?: T): T | undefined {
      return backing.has(key) ? backing.get(key) as T : defaultValue;
    },
    update(key: string, value: unknown): void {
      backing.set(key, value);
    }
  });

  const input = {
    result: {
      command: "npm run typecheck",
      exitCode: 2,
      output: "src/app.ts:10:5 - error TS2322: Type string is not assignable to number.",
      keyLines: ["src/app.ts:10:5 - error TS2322: Type string is not assignable to number."],
      failureKind: "typescript",
      summary: "TS2322 type mismatch"
    },
    source: "manualVerify" as const,
    files: ["src/app.ts"],
    prompt: "淇 src/app.ts 绫诲瀷闂",
    now: new Date("2026-05-23T00:00:00.000Z")
  };

  await store.record(input);
  await store.record({ ...input, now: new Date("2026-05-23T00:01:00.000Z") });
  const records = store.getAll();
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].count, 2);
  assert.strictEqual(records[0].files[0], "src/app.ts");

  const relevant = store.getRelevant({ prompt: "app.ts TS2322", files: ["src/app.ts"] });
  assert.strictEqual(relevant.length, 1);
  assert.ok(formatFailureMemoryForPrompt(relevant, 1000).includes("Recent verification failure memory"));
}

function testFailureMemorySkipsPassingResults(): void {
  const record = buildFailureMemoryRecord({
    result: {
      command: "npm test",
      exitCode: 0,
      output: "pass",
      failureKind: "pass"
    },
    source: "agentVerify"
  });
  assert.strictEqual(record, undefined);
}

function testFailureMemorySelectsByFileAndKind(): void {
  const first = buildFailureMemoryRecord({
    result: {
      command: "npm test",
      exitCode: 1,
      output: "Expected true received false",
      keyLines: ["Expected true received false"],
      failureKind: "test",
      summary: "assertion failed"
    },
    source: "postApply",
    files: ["src/app.test.ts"],
    now: new Date("2026-05-23T00:00:00.000Z")
  });
  const second = buildFailureMemoryRecord({
    result: {
      command: "npm run lint",
      exitCode: 1,
      output: "eslint no-unused-vars",
      keyLines: ["eslint no-unused-vars"],
      failureKind: "lint",
      summary: "lint failed"
    },
    source: "manualVerify",
    files: ["src/style.ts"],
    now: new Date("2026-05-23T00:01:00.000Z")
  });
  assert.ok(first);
  assert.ok(second);
  const selected = selectRelevantFailureMemory([second, first], {
    prompt: "淇 app.test.ts 娴嬭瘯",
    files: ["src/app.test.ts"],
    failureKind: "test"
  });
  assert.strictEqual(selected[0].failureKind, "test");
}

function testWebSearchTrustClassificationAndCitation(): void {
  const official = {
    title: "React useActionState",
    url: "https://react.dev/reference/react/useActionState",
    snippet: "Official docs",
    rank: 2,
    updatedAt: "2026-05-01"
  };
  assert.strictEqual(classifyWebSearchTrust(official, "docs"), "official");
  assert.ok(formatWebSearchCitation(official, "official").includes("#2 official"));

  assert.strictEqual(classifyWebSearchTrust({
    title: "Bug discussion",
    url: "https://github.com/example/repo/issues/1",
    snippet: "Issue",
    rank: 1
  }, "github"), "github");

  assert.strictEqual(classifyWebSearchTrust({
    title: "How to fix",
    url: "https://stackoverflow.com/questions/1",
    snippet: "Community answer",
    rank: 3
  }), "community");
}

function testHighRiskPlanRequiresVerificationAndCheckpoints(): void {
  const basePlan: PatchQualityPlan = {
    riskLevel: "high",
    checkpoints: [],
    verification: [],
    contextGaps: []
  };

  const failedChecks = buildPlanRiskChecks(basePlan);
  assert.strictEqual(failedChecks.find((check) => check.id === "risk-verification")?.status, "fail");
  assert.strictEqual(failedChecks.find((check) => check.id === "risk-checkpoints")?.status, "fail");

  const passingChecks = buildPlanRiskChecks({
    ...basePlan,
    verification: ["npm test"],
    checkpoints: [{
      verification: ["npm test"]
    }]
  });
  assert.strictEqual(passingChecks.find((check) => check.id === "risk-verification")?.status, "pass");
  assert.strictEqual(passingChecks.find((check) => check.id === "risk-checkpoints")?.status, "pass");

  const vagueChecks = buildPlanRiskChecks({
    ...basePlan,
    verification: ["检查结果"],
    checkpoints: [{ verification: ["检查结果"] }]
  });
  assert.strictEqual(vagueChecks.find((check) => check.id === "risk-verification")?.status, "fail");
}

function testStagedTaskPlanLifecycle(): void {
  const plan = {
    summary: "分阶段实现复杂能力",
    riskLevel: "medium" as const,
    files: [
      { path: "src/a.ts", reason: "阶段一" },
      { path: "src/b.ts", reason: "阶段二" },
      { path: "src/c.ts", reason: "阶段三" }
    ],
    checkpoints: [
      { id: "cp1", title: "建立状态机", files: ["src/a.ts"], acceptanceCriteria: ["状态可记录"], verification: ["npm test"] },
      { id: "cp2", title: "接入 UI", files: ["src/b.ts"], acceptanceCriteria: ["UI 可见"], verification: ["npm test"] }
    ],
    steps: ["先状态机", "再 UI"],
    acceptanceCriteria: ["复杂任务可拆分"],
    verification: ["npm test"],
    risks: [],
    contextGaps: [],
    assumptions: []
  };

  assert.strictEqual(shouldUseStagedExecution(plan, "实现复杂任务"), true);
  let task = createStagedTaskState(plan, "实现复杂任务", new Date("2026-05-23T00:00:00.000Z"));
  assert.strictEqual(task.phaseCount, 2);
  assert.strictEqual(task.phases[0].status, "pending");
  task = markCurrentPhaseDraftReady(task, "draft1", ["modify src/a.ts"], new Date("2026-05-23T00:01:00.000Z"));
  assert.strictEqual(task.phases[0].status, "ready");
  task = markCurrentPhaseDone(task, new Date("2026-05-23T00:02:00.000Z"));
  task = advanceStagedTask(task, new Date("2026-05-23T00:03:00.000Z"));
  assert.strictEqual(task.currentPhaseIndex, 1);
  task = markCurrentPhaseFailed(task, "验证失败", new Date("2026-05-23T00:04:00.000Z"));
  assert.strictEqual(task.status, "failed");
  assert.strictEqual(task.phases[1].failureReason, "验证失败");
}

function testStagedPhasePlanAndPromptStayScoped(): void {
  const plan = {
    summary: "实现多模块重构",
    riskLevel: "high" as const,
    files: [
      { path: "src/a.ts", reason: "阶段一" },
      { path: "src/b.ts", reason: "阶段二" }
    ],
    checkpoints: [
      { id: "cp1", title: "阶段一", files: ["src/a.ts"], acceptanceCriteria: ["A 完成"], verification: ["npm test"] },
      { id: "cp2", title: "阶段二", files: ["src/b.ts"], acceptanceCriteria: ["B 完成"], verification: ["npm test"] }
    ],
    steps: ["先 A", "再 B"],
    acceptanceCriteria: ["全部完成"],
    verification: ["npm test"],
    risks: [],
    contextGaps: [],
    assumptions: []
  };
  const task = createStagedTaskState(plan, "重构", new Date("2026-05-23T00:00:00.000Z"));
  const phase = task.phases[0];
  const phasePlan = createPhasePatchPlan(plan, phase, 0, task.phaseCount);
  const stageInfo = createDraftStageInfo(task, phase);
  const prompt = buildStagedPhaseRequest("重构", task, phase);

  assert.strictEqual(phasePlan.files.length, 1);
  assert.strictEqual(phasePlan.files[0].path, "src/a.ts");
  assert.strictEqual(stageInfo.phaseIndex, 1);
  assert.ok(prompt.includes("只执行阶段 1/2"));
  assert.ok(prompt.includes("后续阶段"));
}

function testAgentMemoryDetectsFollowPlanPrompt(): void {
  assert.strictEqual(shouldFollowPlan("可以，继续，逐一完成所有任务"), true);
  assert.strictEqual(shouldFollowPlan("按上面的计划实现"), true);
  assert.strictEqual(shouldFollowPlan("解释一下这个函数"), false);
}

function testAgentMemoryExtractsPreviousPlan(): void {
  const transcript = [
    {
      role: "user" as const,
      content: "先给我一份计划",
      createdAt: "2026-05-19T00:00:00.000Z"
    },
    {
      role: "assistant" as const,
      content: [
        "# 执行计划",
        "- 修改 src/app.ts，接入 Agent 入口",
        "- 修改 src/services/runner.ts，补齐验证流程",
        "",
        "验收：",
        "- npm test 通过",
        "",
        "```ts",
        "const ignored = true;",
        "```"
      ].join("\n"),
      model: "test-model",
      createdAt: "2026-05-19T00:01:00.000Z"
    },
    {
      role: "user" as const,
      content: "可以，继续，逐一完成所有任务",
      createdAt: "2026-05-19T00:02:00.000Z"
    }
  ];
  const memory = buildAgentMemoryContext("可以，继续，逐一完成所有任务", transcript, {
    historyItems: 6,
    historyChars: 4000,
    assistantHistoryChars: 2000,
    userHistoryChars: 600
  });
  assert.strictEqual(memory.shouldFollowPreviousPlan, true);
  assert.ok(memory.planBlock?.includes("src/app.ts"));
  assert.ok(memory.planBlock?.includes("npm test"));
  assert.ok(!memory.planBlock?.includes("ignored"));
}

function testAgentMemoryCompactsPlanBlock(): void {
  const transcript = [{
    role: "assistant" as const,
    content: [
      "## 任务计划",
      ...Array.from({ length: 60 }, (_, index) => `- 第 ${index + 1} 步：修改 src/file${index}.ts 并验证`)
    ].join("\n"),
    createdAt: "2026-05-19T00:00:00.000Z"
  }];
  const extracted = extractPreviousPlanBlock(transcript, 900);
  assert.ok(extracted);
  assert.ok(extracted.length <= 980);
  assert.ok(extracted.includes("[已截断"));
}

function testProviderErrorFormatsMissingApiKey(): void {
  const message = formatProviderErrorForUser(createMissingApiKeyError("DeepSeek"));
  assert.ok(message.includes("DeepSeek"));
  assert.ok(message.includes("API Key"));
}

function testProviderErrorFormatsEmptyReasoningResponse(): void {
  const message = formatProviderErrorForUser(createEmptyResponseError("DeepSeek", {
    finishReason: "stop",
    reasoningOnly: true
  }));
  assert.ok(message.includes("没有返回可用内容"));
  assert.ok(message.includes("思考内容"));
  assert.ok(message.includes("finish_reason"));
}

function testProviderErrorFormatsLengthEmptyResponse(): void {
  const message = formatProviderErrorForUser(createEmptyResponseError("DeepSeek", {
    finishReason: "length"
  }));
  assert.ok(message.includes("没有返回可用内容"));
  assert.ok(message.includes("finish_reason"));
  assert.ok(message.includes("max_tokens"));
  assert.ok(message.includes("拆小"));
}

function testProviderErrorClassifiesContextLength(): void {
  const message = formatProviderErrorForUser(createRequestError("OpenAI", "maximum context length exceeded", 400));
  assert.ok(message.includes("上下文"));
  assert.ok(message.includes("拆小"));
}

function testProviderErrorClassifiesRateLimit(): void {
  const message = formatProviderErrorForUser(createRequestError("Qwen", "rate limit exceeded", 429));
  assert.ok(message.includes("限流"));
}

function testWebSearchProviderKeyPolicy(): void {
  assert.strictEqual(doesSearchProviderNeedApiKey("free"), false);
  assert.strictEqual(doesSearchProviderNeedApiKey("searxng"), false);
  assert.strictEqual(doesSearchProviderNeedApiKey("bing"), true);
  assert.strictEqual(webSearchProviderLabel("free"), "免费搜索");
}

function testFreeSearchBaseUrlsDedupesConfiguredUrl(): void {
  const urls = getFreeSearchBaseUrls("https://search.inetol.net/");
  assert.strictEqual(urls[0], "https://search.inetol.net");
  assert.strictEqual(new Set(urls).size, urls.length);
}

function testParseSearxngHtmlResults(): void {
  const html = [
    "<article class=\"result result-default\">",
    "<h3><a href=\"https://react.dev/reference/react\">React &amp; API</a></h3>",
    "<p class=\"content\">Official <b>React</b> docs.</p>",
    "</article>"
  ].join("");
  const results = parseSearxngHtmlResults(html) as Array<{ title: string; url: string; snippet: string }>;
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].title, "React & API");
  assert.strictEqual(results[0].url, "https://react.dev/reference/react");
  assert.strictEqual(results[0].snippet, "Official React docs.");
}

function testParseDuckDuckGoHtmlResults(): void {
  const html = [
    "<div class=\"result results_links_deep web-result\">",
    "<a class=\"result__a\" href=\"/l/?uddg=https%3A%2F%2Fcode.visualstudio.com%2Fapi\">VS Code API</a>",
    "<a class=\"result__snippet\">Official <b>VS Code</b> extension API docs.</a>",
    "</div>"
  ].join("");
  const results = parseDuckDuckGoHtmlResults(html) as Array<{ title: string; url: string; snippet: string }>;
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].title, "VS Code API");
  assert.strictEqual(results[0].url, "https://code.visualstudio.com/api");
  assert.strictEqual(results[0].snippet, "Official VS Code extension API docs.");
}

function testParseBingHtmlResults(): void {
  const html = [
    "<li class=\"b_algo\">",
    "<h2><a href=\"https://code.visualstudio.com/api\">VS Code API</a></h2>",
    "<p>Official <strong>VS Code</strong> extension API docs.</p>",
    "</li>"
  ].join("");
  const results = parseBingHtmlResults(html) as Array<{ title: string; url: string; snippet: string }>;
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].title, "VS Code API");
  assert.strictEqual(results[0].url, "https://code.visualstudio.com/api");
  assert.strictEqual(results[0].snippet, "Official VS Code extension API docs.");
}

function testParseBaiduHtmlResults(): void {
  const html = [
    "<div class=\"result c-container\" mu=\"https://code.visualstudio.com/api\">",
    "<h3><a href=\"https://www.baidu.com/link?url=x\">VS Code API</a></h3>",
    "<span class=\"c-abstract\">Official <em>VS Code</em> extension API docs.</span>",
    "</div>"
  ].join("");
  const results = parseBaiduHtmlResults(html) as Array<{ title: string; url: string; snippet: string }>;
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].title, "VS Code API");
  assert.strictEqual(results[0].url, "https://code.visualstudio.com/api");
  assert.strictEqual(results[0].snippet, "Official VS Code extension API docs.");
}

function testParseSogouHtmlResults(): void {
  const html = [
    "<div class=\"vrwrap\">",
    "<h3><a href=\"https://code.visualstudio.com/api\">VS Code API</a></h3>",
    "<p class=\"str_info\">Official <em>VS Code</em> extension API docs.</p>",
    "</div>"
  ].join("");
  const results = parseSogouHtmlResults(html) as Array<{ title: string; url: string; snippet: string }>;
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].title, "VS Code API");
  assert.strictEqual(results[0].url, "https://code.visualstudio.com/api");
  assert.strictEqual(results[0].snippet, "Official VS Code extension API docs.");
}

function testWebSearchRelevanceDropsUnrelatedResults(): void {
  const results = rankAndFilterSearchResults([
    {
      title: "【星露谷物语】关于 n 网怎么开启18+内容 - 知乎",
      url: "https://www.zhihu.com/question/123",
      source: "www.zhihu.com",
      snippet: "2021 年 11 月 22 日 N 网下载问题和游戏论坛讨论。",
      rank: 1
    },
    {
      title: "GoFlow 配置文档",
      url: "https://github.com/example/goflow#configuration",
      source: "github.com",
      snippet: "GoFlow README includes configuration docs and setup examples.",
      rank: 2
    }
  ], "goflow 最新配置文档", "docs");

  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].url, "https://github.com/example/goflow#configuration");
}

function testWebSearchRelevancePrefersOfficialDocsOverDownloadSites(): void {
  const results = rankAndFilterSearchResults([
    {
      title: "360驱动大师_360安全中心_全面检测、驱动检测、驱动下载",
      url: "https://dm.weishi.360.cn",
      source: "dm.weishi.360.cn",
      snippet: "专业解决驱动安装更新软件。",
      rank: 1
    },
    {
      title: "Patchlane VS Code Agent 官方文档",
      url: "https://github.com/example/patchlane/blob/main/README.md",
      source: "github.com",
      snippet: "Patchlane VS Code Agent installation, configuration and web search docs.",
      rank: 2
    },
    {
      title: "Patchlane 配置指南",
      url: "https://example.com/patchlane/configuration",
      source: "example.com",
      snippet: "Patchlane 配置模型、联网搜索和 Agent 工具。",
      rank: 3
    }
  ], "Patchlane VS Code Agent 最新文档", "docs");

  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].source, "github.com");
  assert.ok(results.every((item) => item.title.includes("Patchlane") || item.snippet.includes("Patchlane")));
}

function testFreeSearchErrorDoesNotAskForApiKey(): void {
  const message = formatWebSearchError(new Error([
    "免费搜索暂时不可用。",
    "可以切换到 Tavily、Brave、Bing 或 SerpAPI 并填写对应 Key。"
  ].join("\n")), "free");
  assert.ok(message.includes("免费搜索暂时不可用"));
  assert.ok(!message.includes("需要有效的搜索 API Key"));
}

function testCommercialSearchErrorAsksForApiKey(): void {
  const message = formatWebSearchError(new Error("API Key missing"), "bing");
  assert.ok(message.includes("Bing"));
  assert.ok(message.includes("API Key"));
}

function testMcpHttpParsesPlainJsonResponse(): void {
  const parsed = parseHttpMcpPayload(JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    result: { tools: [] }
  }), 7);
  assert.deepStrictEqual(parsed, {
    jsonrpc: "2.0",
    id: 7,
    result: { tools: [] }
  });
}

function testMcpHttpFiltersBatchByExpectedId(): void {
  const parsed = parseHttpMcpPayload(JSON.stringify([
    { jsonrpc: "2.0", id: 1, result: { wrong: true } },
    { jsonrpc: "2.0", id: 2, result: { ok: true } }
  ]), 2);
  assert.deepStrictEqual(parsed, { jsonrpc: "2.0", id: 2, result: { ok: true } });
}

function testMcpHttpParsesSsePayload(): void {
  const payload = [
    "event: message",
    'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
    "",
    "event: message",
    'data: {"jsonrpc":"2.0","id":9,"result":{"content":[{"type":"text","text":"done"}]}}',
    "",
    "data: [DONE]"
  ].join("\n");
  const parsed = parseHttpMcpPayload(payload, 9);
  assert.deepStrictEqual(parsed, {
    jsonrpc: "2.0",
    id: 9,
    result: { content: [{ type: "text", text: "done" }] }
  });
}

function testMcpHttpParsesMultilineSseData(): void {
  const payload = [
    "event: message",
    'data: {"jsonrpc":"2.0",',
    'data: "id":4,',
    'data: "result":{"value":"multi-line"}}',
    ""
  ].join("\n");
  const parsed = parseHttpMcpPayload(payload, 4);
  assert.deepStrictEqual(parsed, {
    jsonrpc: "2.0",
    id: 4,
    result: { value: "multi-line" }
  });
}

function testMcpHttpIgnoresDoneOnlySsePayload(): void {
  assert.deepStrictEqual(parseHttpMcpPayload("data: [DONE]\n\n", 1), {});
}

function testCapabilityManifestParsesSharedCapabilities(): void {
  const manifest = parseCapabilityManifestJson(JSON.stringify({
    version: "1.2.3",
    skills: [{
      id: "frontend-review",
      label: "前端体验审查",
      description: "检查页面体验",
      runtime: "node",
      script: ".patchlane/skills/frontend-review/index.js"
    }],
    tools: [{
      id: "project-summary",
      label: "项目摘要",
      description: "读取项目摘要",
      kind: "custom",
      runtime: "node",
      script: ".patchlane/tools/project-summary/index.js",
      args: ["--brief"]
    }],
    mcpServers: {
      docs: {
        transport: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer token" },
        tools: [{ name: "search_docs", label: "搜索文档" }]
      }
    }
  }));

  assert.strictEqual(manifest.version, "1.2.3");
  assert.strictEqual(manifest.skills.length, 1);
  assert.strictEqual(manifest.skills[0].kind, "custom");
  assert.strictEqual(manifest.tools[0].args?.[0], "--brief");
  assert.strictEqual(manifest.mcpServers.docs.transport, "http");
  assert.strictEqual(manifest.mcpServers.docs.tools?.[0].name, "search_docs");
  assert.deepStrictEqual(manifest.diagnostics, []);
}

function testCapabilityManifestReportsInvalidItems(): void {
  const manifest = parseCapabilityManifestJson(JSON.stringify({
    skills: [{ id: "bad-skill", label: "缺少描述" }],
    tools: "bad",
    mcpServers: {
      "": {},
      valid: { tools: [{ label: "缺少 name" }] }
    }
  }));

  assert.strictEqual(manifest.skills.length, 0);
  assert.strictEqual(manifest.tools.length, 0);
  assert.ok(manifest.mcpServers.valid);
  assert.ok(manifest.diagnostics.length >= 3);
  assert.ok(manifest.diagnostics.some((item) => item.path === "skills[0]"));
  assert.ok(manifest.diagnostics.some((item) => item.path === "tools"));
  assert.ok(manifest.diagnostics.some((item) => item.path === "mcpServers.valid.tools[0]"));
}

function testCapabilityManifestReportsInvalidJson(): void {
  const manifest = parseCapabilityManifestJson("{ bad json");
  assert.strictEqual(manifest.skills.length, 0);
  assert.strictEqual(manifest.tools.length, 0);
  assert.strictEqual(Object.keys(manifest.mcpServers).length, 0);
  assert.strictEqual(manifest.diagnostics[0].severity, "error");
  assert.ok(manifest.diagnostics[0].message.includes("合法 JSON"));
}

function testFailureStrategyClassifiesProviderEmptyResponse(): void {
  const strategy = createFailureStrategyFromProviderMessage("DeepSeek 没有返回可用内容：模型只返回了思考内容。");
  assert.strictEqual(strategy.kind, "model_empty_response");
  const prompt = formatFailureStrategyForPrompt(strategy);
  assert.ok(prompt.includes("失败归因"));
  assert.ok(prompt.includes("拆成更小步骤"));
}

function testFailureStrategyClassifiesPatchQuality(): void {
  const strategy = createFailureStrategyFromQuality({
    status: "fail",
    summary: "Patch hunk 行数不一致",
    checks: [{
      id: "complete",
      label: "Patch 完整性",
      status: "fail",
      detail: "src/app.ts 的 hunk 行数与头部声明不一致，可能是模型输出被截断。"
    }]
  });
  assert.strictEqual(strategy.kind, "patch_incomplete");
  assert.ok(strategy.userActions.some((item) => item.includes("拆小")));
}

function testFailureStrategyClassifiesApplyConflict(): void {
  const strategy = createFailureStrategyFromApplyError("修改上下文不匹配：example.ts");
  assert.strictEqual(strategy.kind, "patch_apply_conflict");
  assert.ok(strategy.promptGuidance.some((item) => item.includes("当前文件内容")));
}

function testFailureStrategyClassifiesVerifyFailure(): void {
  const strategy = createFailureStrategyFromVerify({
    command: "npm run typecheck",
    exitCode: 2,
    output: "TS2322: Type 'string' is not assignable to type 'number'.",
    durationMs: 120,
    failureKind: "typescript",
    summary: "类型检查失败"
  });
  assert.strictEqual(strategy.kind, "verify_typescript");
  assert.ok(strategy.summary.includes("TypeScript"));
}

async function testReadSseJsonRpcResponseConsumesIncrementalStream(): Promise<void> {
  const encoder = new TextEncoder();
  const chunks = [
    "event: message\n",
    'data: {"jsonrpc":"2.0","id":1,"result":{"wrong":true}}\n\n',
    "event: message\n",
    'data: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n'
  ];
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    }
  }), {
    headers: {
      "content-type": "text/event-stream"
    }
  });
  const parsed = await readSseJsonRpcResponse(response, 3);
  assert.deepStrictEqual(parsed, { jsonrpc: "2.0", id: 3, result: { ok: true } });
}

async function run(): Promise<void> {
  testModifyPatch();
  testCreatePatch();
  testUnsafePath();
  testExtractsFencedDiff();
  testContextMismatchThrowsDiagnosticError();
  testFilterPatchHunksKeepsSelectedHunkOnly();
  testParseGitStatusSnapshot();
  testToolPlanParsesFencedJson();
  testToolPlanFiltersInvalidAndDedupesActions();
  testCompactTextKeepsHeadAndTail();
  testScopedVerifyPlanPrefersRelevantCommands();
  testPatchRiskLevelInference();
  testRepoProfileSummarizesCodeMap();
  await testFailureMemoryStoresDedupesAndFormats();
  testFailureMemorySkipsPassingResults();
  testFailureMemorySelectsByFileAndKind();
  testWebSearchTrustClassificationAndCitation();
  testHighRiskPlanRequiresVerificationAndCheckpoints();
  testStagedTaskPlanLifecycle();
  testStagedPhasePlanAndPromptStayScoped();
  testAgentMemoryDetectsFollowPlanPrompt();
  testAgentMemoryExtractsPreviousPlan();
  testAgentMemoryCompactsPlanBlock();
  testProviderErrorFormatsMissingApiKey();
  testProviderErrorFormatsEmptyReasoningResponse();
  testProviderErrorFormatsLengthEmptyResponse();
  testProviderErrorClassifiesContextLength();
  testProviderErrorClassifiesRateLimit();
  testWebSearchProviderKeyPolicy();
  testFreeSearchBaseUrlsDedupesConfiguredUrl();
  testParseSearxngHtmlResults();
  testParseDuckDuckGoHtmlResults();
  testParseBingHtmlResults();
  testParseBaiduHtmlResults();
  testParseSogouHtmlResults();
  testWebSearchRelevanceDropsUnrelatedResults();
  testWebSearchRelevancePrefersOfficialDocsOverDownloadSites();
  testFreeSearchErrorDoesNotAskForApiKey();
  testCommercialSearchErrorAsksForApiKey();
  testMcpHttpParsesPlainJsonResponse();
  testMcpHttpFiltersBatchByExpectedId();
  testMcpHttpParsesSsePayload();
  testMcpHttpParsesMultilineSseData();
  testMcpHttpIgnoresDoneOnlySsePayload();
  testCapabilityManifestParsesSharedCapabilities();
  testCapabilityManifestReportsInvalidItems();
  testCapabilityManifestReportsInvalidJson();
  testFailureStrategyClassifiesProviderEmptyResponse();
  testFailureStrategyClassifiesPatchQuality();
  testFailureStrategyClassifiesApplyConflict();
  testFailureStrategyClassifiesVerifyFailure();
  await testReadSseJsonRpcResponseConsumesIncrementalStream();
  console.log("patchService tests passed");
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
