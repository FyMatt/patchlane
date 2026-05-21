import * as fs from "fs";
import type { AgentCapabilityConfig, McpServerConfig, McpServerToolConfig } from "../config";

export interface CapabilityManifestDiagnostic {
  severity: "warning" | "error";
  path: string;
  message: string;
}

export interface NormalizedCapabilityManifest {
  version?: string;
  skills: AgentCapabilityConfig[];
  tools: AgentCapabilityConfig[];
  mcpServers: Record<string, McpServerConfig>;
  diagnostics: CapabilityManifestDiagnostic[];
}

type JsonObject = Record<string, unknown>;

const EMPTY_MANIFEST: NormalizedCapabilityManifest = {
  skills: [],
  tools: [],
  mcpServers: {},
  diagnostics: []
};

export function emptyCapabilityManifest(): NormalizedCapabilityManifest {
  return cloneManifest(EMPTY_MANIFEST);
}

export function loadCapabilityManifestFromFile(filePath: string): NormalizedCapabilityManifest {
  if (!fs.existsSync(filePath)) {
    return emptyCapabilityManifest();
  }

  try {
    return parseCapabilityManifestJson(fs.readFileSync(filePath, "utf8"), ".patchlane/patchlane.json");
  } catch (error) {
    return {
      skills: [],
      tools: [],
      mcpServers: {},
      diagnostics: [{
        severity: "error",
        path: ".patchlane/patchlane.json",
        message: error instanceof Error ? error.message : String(error)
      }]
    };
  }
}

export function parseCapabilityManifestJson(text: string, source = ".patchlane/patchlane.json"): NormalizedCapabilityManifest {
  try {
    return normalizeCapabilityManifest(JSON.parse(text) as unknown, source);
  } catch (error) {
    return {
      skills: [],
      tools: [],
      mcpServers: {},
      diagnostics: [{
        severity: "error",
        path: source,
        message: `清单不是合法 JSON：${error instanceof Error ? error.message : String(error)}`
      }]
    };
  }
}

export function normalizeCapabilityManifest(value: unknown, source = ".patchlane/patchlane.json"): NormalizedCapabilityManifest {
  const diagnostics: CapabilityManifestDiagnostic[] = [];
  if (!isRecord(value)) {
    return {
      skills: [],
      tools: [],
      mcpServers: {},
      diagnostics: [{
        severity: "error",
        path: source,
        message: "清单根节点必须是 JSON 对象。"
      }]
    };
  }

  const version = typeof value.version === "string" && value.version.trim()
    ? value.version.trim()
    : typeof value.version === "number"
      ? String(value.version)
      : undefined;

  return {
    version,
    skills: dedupeCapabilities(normalizeCapabilities(value.skills, "skills", "custom", diagnostics)),
    tools: dedupeCapabilities(normalizeCapabilities(value.tools, "tools", "custom", diagnostics)),
    mcpServers: normalizeManifestMcpServers(value.mcpServers, diagnostics),
    diagnostics
  };
}

function normalizeCapabilities(
  value: unknown,
  section: "skills" | "tools",
  defaultKind: "custom" | "mcp",
  diagnostics: CapabilityManifestDiagnostic[]
): AgentCapabilityConfig[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    diagnostics.push({
      severity: "warning",
      path: section,
      message: `${section} 必须是数组，当前配置已忽略。`
    });
    return [];
  }

  const items: AgentCapabilityConfig[] = [];
  value.forEach((item, index) => {
    const path = `${section}[${index}]`;
    if (!isRecord(item)) {
      diagnostics.push({ severity: "warning", path, message: "能力配置必须是对象，已忽略。" });
      return;
    }

    const id = stringField(item.id);
    const label = stringField(item.label);
    const description = stringField(item.description);
    if (!id || !label || !description) {
      diagnostics.push({ severity: "warning", path, message: "能力必须包含 id、label、description，已忽略。" });
      return;
    }

    const runtime = normalizeRuntime(item.runtime);
    const kind = normalizeKind(item.kind, defaultKind);
    const args = stringArray(item.args);
    items.push({
      id,
      label,
      description,
      kind,
      command: stringField(item.command),
      server: stringField(item.server),
      script: stringField(item.script),
      runtime,
      args: args.length > 0 ? args : undefined
    });
  });
  return items;
}

function normalizeManifestMcpServers(value: unknown, diagnostics: CapabilityManifestDiagnostic[]): Record<string, McpServerConfig> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    diagnostics.push({
      severity: "warning",
      path: "mcpServers",
      message: "mcpServers 必须是对象，当前配置已忽略。"
    });
    return {};
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [rawName, rawServer] of Object.entries(value)) {
    const name = rawName.trim();
    const path = `mcpServers.${rawName}`;
    if (!name) {
      diagnostics.push({ severity: "warning", path, message: "MCP 服务名不能为空，已忽略。" });
      continue;
    }
    if (!isRecord(rawServer)) {
      diagnostics.push({ severity: "warning", path, message: "MCP 服务配置必须是对象，已忽略。" });
      continue;
    }

    const transport = rawServer.transport === "http" ? "http" : "stdio";
    const server: McpServerConfig = {
      transport,
      command: stringField(rawServer.command),
      args: stringArray(rawServer.args),
      cwd: stringField(rawServer.cwd),
      env: stringRecord(rawServer.env),
      url: stringField(rawServer.url),
      headers: stringRecord(rawServer.headers),
      enabled: rawServer.enabled !== false,
      tools: normalizeMcpTools(rawServer.tools, `${path}.tools`, diagnostics)
    };

    if (server.args?.length === 0) {
      delete server.args;
    }
    if (server.tools?.length === 0) {
      delete server.tools;
    }
    if (server.env && Object.keys(server.env).length === 0) {
      delete server.env;
    }
    if (server.headers && Object.keys(server.headers).length === 0) {
      delete server.headers;
    }
    servers[name] = server;
  }
  return servers;
}

function normalizeMcpTools(
  value: unknown,
  path: string,
  diagnostics: CapabilityManifestDiagnostic[]
): McpServerToolConfig[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    diagnostics.push({ severity: "warning", path, message: "MCP tools 必须是数组，已忽略。" });
    return undefined;
  }

  const tools: McpServerToolConfig[] = [];
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      diagnostics.push({ severity: "warning", path: itemPath, message: "MCP tool 必须是对象，已忽略。" });
      return;
    }
    const name = stringField(item.name);
    if (!name) {
      diagnostics.push({ severity: "warning", path: itemPath, message: "MCP tool 必须包含 name，已忽略。" });
      return;
    }
    tools.push({
      name,
      label: stringField(item.label),
      description: stringField(item.description)
    });
  });
  return tools;
}

function normalizeKind(value: unknown, fallback: "custom" | "mcp"): AgentCapabilityConfig["kind"] {
  return value === "builtin" || value === "custom" || value === "mcp" ? value : fallback;
}

function normalizeRuntime(value: unknown): AgentCapabilityConfig["runtime"] | undefined {
  return value === "node" || value === "python" || value === "shell" || value === "mcp" || value === "custom"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key, item]) => key.trim() && typeof item === "string" && item.trim())
      .map(([key, item]) => [key.trim(), (item as string).trim()])
  );
}

function dedupeCapabilities(items: AgentCapabilityConfig[]): AgentCapabilityConfig[] {
  const seen = new Set<string>();
  const result: AgentCapabilityConfig[] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function cloneManifest(value: NormalizedCapabilityManifest): NormalizedCapabilityManifest {
  return {
    version: value.version,
    skills: [...value.skills],
    tools: [...value.tools],
    mcpServers: { ...value.mcpServers },
    diagnostics: [...value.diagnostics]
  };
}
