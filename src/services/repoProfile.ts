import * as vscode from "vscode";
import { CodeMap } from "./workspaceCodeMap";

export interface RepoProfile {
  updatedAt: string;
  languages: string[];
  roles: string[];
  entrypoints: string[];
  testFiles: string[];
  configFiles: string[];
  packageScripts: string[];
  testFrameworks: string[];
}

const STORAGE_KEY = "patchlane.repoProfile.v1";

export class RepoProfileStore {
  public constructor(private readonly state: vscode.Memento) {}

  public get(): RepoProfile | undefined {
    return this.state.get<RepoProfile>(STORAGE_KEY);
  }

  public async updateFromCodeMap(codeMap: CodeMap): Promise<RepoProfile> {
    const profile = buildRepoProfile(codeMap);
    await this.state.update(STORAGE_KEY, profile);
    return profile;
  }
}

export function buildRepoProfile(codeMap: CodeMap, now = new Date()): RepoProfile {
  const languageCounts = countBy(codeMap.files.map((file) => file.languageId));
  const roleCounts = countBy(codeMap.files.flatMap((file) => file.roles));
  const testFiles = codeMap.files
    .filter((file) => file.roles.includes("test"))
    .map((file) => file.path)
    .slice(0, 8);
  const configFiles = codeMap.files
    .filter((file) => file.roles.includes("config") || file.roles.includes("manifest"))
    .map((file) => file.path)
    .slice(0, 8);

  return {
    updatedAt: now.toISOString(),
    languages: topKeys(languageCounts, 6),
    roles: topKeys(roleCounts, 8),
    entrypoints: inferEntrypoints(codeMap),
    testFiles,
    configFiles,
    packageScripts: codeMap.packageScripts.slice(0, 12),
    testFrameworks: inferTestFrameworks(codeMap)
  };
}

export function formatRepoProfileForPrompt(profile: RepoProfile, maxChars: number): string {
  return compactText([
    "Repo profile:",
    `Updated: ${profile.updatedAt}`,
    `Languages: ${profile.languages.join(", ") || "unknown"}`,
    `Roles: ${profile.roles.join(", ") || "unknown"}`,
    "Entrypoints:",
    ...(profile.entrypoints.length > 0 ? profile.entrypoints.map((item) => `- ${item}`) : ["- none"]),
    "Test files:",
    ...(profile.testFiles.length > 0 ? profile.testFiles.map((item) => `- ${item}`) : ["- none"]),
    "Config/manifest files:",
    ...(profile.configFiles.length > 0 ? profile.configFiles.map((item) => `- ${item}`) : ["- none"]),
    "Package scripts:",
    ...(profile.packageScripts.length > 0 ? profile.packageScripts.map((item) => `- ${item}`) : ["- none"]),
    `Test frameworks: ${profile.testFrameworks.join(", ") || "unknown"}`
  ].join("\n"), maxChars);
}

function inferEntrypoints(codeMap: CodeMap): string[] {
  const entrypointPattern = /(^|\/)(index|main|app|extension|server|cli)\.[tj]sx?$|(^|\/)(main|app)\.py$/i;
  return codeMap.files
    .filter((file) => file.roles.includes("source") && entrypointPattern.test(file.path))
    .map((file) => file.path)
    .slice(0, 8);
}

function inferTestFrameworks(codeMap: CodeMap): string[] {
  const text = [
    ...codeMap.packageScripts,
    ...codeMap.files.map((file) => `${file.path} ${file.imports.join(" ")}`)
  ].join("\n").toLowerCase();
  const frameworks: string[] = [];
  for (const [name, pattern] of [
    ["vitest", /vitest/],
    ["jest", /jest/],
    ["mocha", /mocha/],
    ["playwright", /playwright/],
    ["cypress", /cypress/],
    ["pytest", /pytest/],
    ["go test", /go test/],
    ["cargo test", /cargo test/]
  ] as const) {
    if (pattern.test(text)) {
      frameworks.push(name);
    }
  }
  return frameworks;
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values.filter(Boolean)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function topKeys(counts: Map<string, number>, limit: number): string[] {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([key]) => key)
    .slice(0, limit);
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const head = Math.max(600, Math.floor(maxChars * 0.72));
  const tail = Math.max(300, maxChars - head);
  return `${value.slice(0, head)}\n\n[已截断 ${value.length - maxChars} 字符]\n\n${value.slice(-tail)}`;
}
