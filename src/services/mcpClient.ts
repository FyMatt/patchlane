import * as cp from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { AgentCapabilityConfig, getMcpServerConfigs, McpServerConfig, McpServerLogEntry, McpServerSummary } from "../config";
import { JsonRpcResponse, parseHttpMcpPayload, readSseJsonRpcResponse } from "./mcpHttpParser";

export interface McpCallResult {
  server: string;
  tool: string;
  content: string;
  raw: unknown;
}

export interface McpResourceReadResult {
  server: string;
  uri: string;
  content: string;
  raw: unknown;
}

export interface McpPromptGetResult {
  server: string;
  prompt: string;
  content: string;
  raw: unknown;
}

export interface McpRequestOptions {
  signal?: AbortSignal;
}

export interface McpDiscoveredTool {
  name: string;
  label: string;
  description: string;
  inputSchema?: unknown;
}

export interface McpDiscoveredResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpDiscoveredPrompt {
  name: string;
  label: string;
  description?: string;
  arguments?: McpDiscoveredPromptArgument[];
}

export interface McpDiscoveredPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface McpDiscoveredServerCatalog {
  name: string;
  tools: McpDiscoveredTool[];
  resources: McpDiscoveredResource[];
  prompts: McpDiscoveredPrompt[];
}

export interface McpServerRuntimeStatus {
  name: string;
  status: NonNullable<McpServerSummary["status"]>;
  discoveredToolCount: number;
  discoveredResourceCount: number;
  discoveredPromptCount: number;
  lastError?: string;
  pid?: number;
}

interface RunningMcpServer {
  name: string;
  transport: "stdio";
  process: cp.ChildProcessWithoutNullStreams;
  nextId: number;
  buffer: string;
  pending: Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>;
  initialized: boolean;
  status: McpServerRuntimeStatus["status"];
  lastError?: string;
  discoveredTools: McpDiscoveredTool[];
  discoveredResources: McpDiscoveredResource[];
  discoveredPrompts: McpDiscoveredPrompt[];
}

interface HttpMcpServer {
  name: string;
  transport: "http";
  url: string;
  headers: Record<string, string>;
  nextId: number;
  initialized: boolean;
  status: McpServerRuntimeStatus["status"];
  lastError?: string;
  discoveredTools: McpDiscoveredTool[];
  discoveredResources: McpDiscoveredResource[];
  discoveredPrompts: McpDiscoveredPrompt[];
}

type McpConnection = RunningMcpServer | HttpMcpServer;

const REQUEST_TIMEOUT_MS = 30000;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2024-11-05"];

export class McpClientService implements vscode.Disposable {
  private readonly servers = new Map<string, RunningMcpServer>();
  private readonly httpServers = new Map<string, HttpMcpServer>();
  private readonly discoveredToolsByServer = new Map<string, McpDiscoveredTool[]>();
  private readonly discoveredResourcesByServer = new Map<string, McpDiscoveredResource[]>();
  private readonly discoveredPromptsByServer = new Map<string, McpDiscoveredPrompt[]>();
  private readonly lastErrorsByServer = new Map<string, string>();
  private readonly statusByServer = new Map<string, McpServerRuntimeStatus["status"]>();
  private readonly logsByServer = new Map<string, McpServerLogEntry[]>();

  public async callTool(serverName: string, toolName: string, input?: string, options: McpRequestOptions = {}): Promise<McpCallResult> {
    const server = await this.getOrStartServer(serverName);
    const args = parseToolInput(input);
    const result = await this.request(server, "tools/call", {
      name: toolName,
      arguments: args
    }, options);
    return {
      server: serverName,
      tool: toolName,
      content: formatMcpContent(result),
      raw: result
    };
  }

  public async readResource(serverName: string, uri: string, options: McpRequestOptions = {}): Promise<McpResourceReadResult> {
    const server = await this.getOrStartServer(serverName);
    const result = await this.request(server, "resources/read", { uri }, options);
    return {
      server: serverName,
      uri,
      content: formatMcpResourceContent(result),
      raw: result
    };
  }

  public async getPrompt(serverName: string, promptName: string, input?: string | Record<string, unknown>, options: McpRequestOptions = {}): Promise<McpPromptGetResult> {
    const server = await this.getOrStartServer(serverName);
    const args = parseToolInput(input);
    const result = await this.request(server, "prompts/get", {
      name: promptName,
      arguments: args
    }, options);
    return {
      server: serverName,
      prompt: promptName,
      content: formatMcpPromptContent(result),
      raw: result
    };
  }

  public async listTools(serverName: string): Promise<unknown> {
    const server = await this.getOrStartServer(serverName);
    return this.request(server, "tools/list", {});
  }

  public async listResources(serverName: string): Promise<unknown> {
    const server = await this.getOrStartServer(serverName);
    return this.request(server, "resources/list", {});
  }

  public async listPrompts(serverName: string): Promise<unknown> {
    const server = await this.getOrStartServer(serverName);
    return this.request(server, "prompts/list", {});
  }

  public async discoverTools(serverName?: string): Promise<Record<string, McpDiscoveredTool[]>> {
    const configs = getMcpServerConfigs();
    const serverNames = serverName ? [serverName] : Object.keys(configs);
    const discovered: Record<string, McpDiscoveredTool[]> = {};
    for (const name of serverNames) {
      const config = configs[name];
      if (!config || config.enabled === false) {
        continue;
      }
      try {
        this.appendLog(name, "info", "开始发现 MCP 能力。");
        const raw = await this.listTools(name);
        const tools = normalizeMcpTools(raw);
        this.discoveredToolsByServer.set(name, tools);
        await this.tryDiscoverResourcesAndPrompts(name);
        const running = this.servers.get(name);
        if (running) {
          running.discoveredTools = tools;
          running.status = "running";
          running.lastError = undefined;
        }
        const http = this.httpServers.get(name);
        if (http) {
          http.discoveredTools = tools;
          http.status = "running";
          http.lastError = undefined;
        }
        discovered[name] = tools;
        this.appendLog(name, "info", `发现 ${tools.length} 个工具。`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastErrorsByServer.set(name, message);
        this.statusByServer.set(name, "error");
        this.appendLog(name, "error", "发现 MCP 能力失败。", message);
        const running = this.servers.get(name);
        if (running) {
          running.status = "error";
          running.lastError = message;
        }
        const http = this.httpServers.get(name);
        if (http) {
          http.status = "error";
          http.lastError = message;
        }
        discovered[name] = [];
      }
    }
    return discovered;
  }

  public async discoverCatalog(serverName?: string): Promise<Record<string, McpDiscoveredServerCatalog>> {
    await this.discoverTools(serverName);
    const configs = getMcpServerConfigs();
    const serverNames = serverName ? [serverName] : Object.keys(configs);
    for (const name of serverNames) {
      const config = configs[name];
      if (!config || config.enabled === false) {
        continue;
      }
      await this.tryDiscoverResourcesAndPrompts(name);
    }
    const catalog: Record<string, McpDiscoveredServerCatalog> = {};
    for (const item of this.getDiscoveredCatalog()) {
      if (!serverName || item.name === serverName) {
        catalog[item.name] = item;
      }
    }
    return catalog;
  }

  public getDiscoveredCatalog(): McpDiscoveredServerCatalog[] {
    const names = new Set<string>([
      ...Object.keys(getMcpServerConfigs()),
      ...this.discoveredToolsByServer.keys(),
      ...this.discoveredResourcesByServer.keys(),
      ...this.discoveredPromptsByServer.keys()
    ]);

    return [...names].sort((left, right) => left.localeCompare(right)).map((name) => ({
      name,
      tools: this.discoveredToolsByServer.get(name) ?? [],
      resources: this.discoveredResourcesByServer.get(name) ?? [],
      prompts: this.discoveredPromptsByServer.get(name) ?? []
    }));
  }

  public getDiscoveredToolCapabilities(): AgentCapabilityConfig[] {
    const tools: AgentCapabilityConfig[] = [];
    for (const [serverName, discovered] of this.discoveredToolsByServer.entries()) {
      for (const tool of discovered) {
        tools.push({
          id: `mcp:${serverName}:${tool.name}`,
          label: tool.label || `${serverName}/${tool.name}`,
          description: tool.description || `调用 MCP 服务 ${serverName} 的工具 ${tool.name}`,
          kind: "mcp",
          server: serverName,
          command: tool.name,
          runtime: "mcp"
        });
      }
    }
    return tools;
  }

  public getRuntimeSummary(): Record<string, Partial<McpServerSummary>> {
    const summary: Record<string, Partial<McpServerSummary>> = {};
    for (const [name, tools] of this.discoveredToolsByServer.entries()) {
      summary[name] = {
        discoveredToolCount: tools.length,
        discoveredResourceCount: this.discoveredResourcesByServer.get(name)?.length ?? 0,
        discoveredPromptCount: this.discoveredPromptsByServer.get(name)?.length ?? 0,
        status: "notStarted"
      };
    }
    for (const [name, resources] of this.discoveredResourcesByServer.entries()) {
      summary[name] = {
        ...summary[name],
        discoveredToolCount: summary[name]?.discoveredToolCount ?? 0,
        discoveredResourceCount: resources.length,
        discoveredPromptCount: summary[name]?.discoveredPromptCount ?? 0,
        lastError: summary[name]?.lastError,
        status: summary[name]?.status ?? "notStarted"
      };
    }
    for (const [name, prompts] of this.discoveredPromptsByServer.entries()) {
      summary[name] = {
        ...summary[name],
        discoveredToolCount: summary[name]?.discoveredToolCount ?? 0,
        discoveredResourceCount: summary[name]?.discoveredResourceCount ?? 0,
        discoveredPromptCount: prompts.length,
        lastError: summary[name]?.lastError,
        status: summary[name]?.status ?? "notStarted"
      };
    }
    for (const [name, server] of this.httpServers.entries()) {
      summary[name] = {
        ...summary[name],
        status: server.status,
        discoveredToolCount: server.discoveredTools.length,
        discoveredResourceCount: server.discoveredResources.length,
        discoveredPromptCount: server.discoveredPrompts.length,
        lastError: server.lastError
      };
    }
    for (const [name, server] of this.servers.entries()) {
      summary[name] = {
        ...summary[name],
        status: server.status,
        discoveredToolCount: server.discoveredTools.length,
        discoveredResourceCount: server.discoveredResources.length,
        discoveredPromptCount: server.discoveredPrompts.length,
        lastError: server.lastError,
        pid: server.process.pid
      };
    }
    for (const [name, status] of this.statusByServer.entries()) {
      summary[name] = {
        ...summary[name],
        status
      };
    }
    for (const [name, lastError] of this.lastErrorsByServer.entries()) {
      summary[name] = {
        ...summary[name],
        status: "error",
        lastError
      };
    }
    for (const [name, logs] of this.logsByServer.entries()) {
      summary[name] = {
        ...summary[name],
        recentLogs: logs.slice(-8)
      };
    }
    return summary;
  }

  public getServerLogs(serverName: string): McpServerLogEntry[] {
    return [...(this.logsByServer.get(serverName) ?? [])];
  }

  public clearServerLogs(serverName?: string): void {
    if (serverName) {
      this.logsByServer.delete(serverName);
      return;
    }
    this.logsByServer.clear();
  }

  public async restartServer(serverName: string): Promise<void> {
    this.stopServer(serverName);
    this.lastErrorsByServer.delete(serverName);
    this.statusByServer.delete(serverName);
    this.appendLog(serverName, "info", "正在重新连接 MCP 服务。");
    await this.getOrStartServer(serverName);
    await this.tryDiscoverResourcesAndPrompts(serverName);
  }

  public stopServer(serverName: string): void {
    const running = this.servers.get(serverName);
    if (running) {
      running.status = "stopped";
      this.servers.delete(serverName);
      for (const pending of running.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP 服务已停止：${serverName}`));
      }
      running.pending.clear();
      running.process.kill();
      this.statusByServer.set(serverName, "stopped");
      this.appendLog(serverName, "info", "已停止 stdio MCP 服务。");
      return;
    }

    if (this.httpServers.delete(serverName)) {
      this.statusByServer.set(serverName, "stopped");
      this.appendLog(serverName, "info", "已断开 HTTP MCP 服务。");
      return;
    }

    this.statusByServer.set(serverName, "stopped");
    this.appendLog(serverName, "info", "MCP 服务当前未运行，已标记为停止。");
  }

  public dispose(): void {
    for (const server of this.servers.values()) {
      server.process.kill();
      for (const pending of server.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("MCP 服务已关闭。"));
      }
      server.pending.clear();
    }
    this.httpServers.clear();
    this.servers.clear();
  }

  private async tryDiscoverResourcesAndPrompts(serverName: string): Promise<void> {
    let optionalListSucceeded = false;
    try {
      const rawResources = await this.listResources(serverName);
      const resources = normalizeMcpResources(rawResources);
      optionalListSucceeded = true;
      this.discoveredResourcesByServer.set(serverName, resources);
      this.appendLog(serverName, "info", `发现 ${resources.length} 个资源。`);
      const running = this.servers.get(serverName);
      if (running) {
        running.discoveredResources = resources;
      }
      const http = this.httpServers.get(serverName);
      if (http) {
        http.discoveredResources = resources;
      }
    } catch {
      this.discoveredResourcesByServer.set(serverName, []);
      const running = this.servers.get(serverName);
      if (running) {
        running.discoveredResources = [];
      }
      const http = this.httpServers.get(serverName);
      if (http) {
        http.discoveredResources = [];
      }
      // resources/list is optional in MCP servers.
    }

    try {
      const rawPrompts = await this.listPrompts(serverName);
      const prompts = normalizeMcpPrompts(rawPrompts);
      optionalListSucceeded = true;
      this.discoveredPromptsByServer.set(serverName, prompts);
      this.appendLog(serverName, "info", `发现 ${prompts.length} 个 Prompt。`);
      const running = this.servers.get(serverName);
      if (running) {
        running.discoveredPrompts = prompts;
      }
      const http = this.httpServers.get(serverName);
      if (http) {
        http.discoveredPrompts = prompts;
      }
    } catch {
      this.discoveredPromptsByServer.set(serverName, []);
      const running = this.servers.get(serverName);
      if (running) {
        running.discoveredPrompts = [];
      }
      const http = this.httpServers.get(serverName);
      if (http) {
        http.discoveredPrompts = [];
      }
      // prompts/list is optional in MCP servers.
    }

    if (optionalListSucceeded) {
      this.lastErrorsByServer.delete(serverName);
      this.statusByServer.set(serverName, "running");
      const running = this.servers.get(serverName);
      if (running) {
        running.status = "running";
        running.lastError = undefined;
      }
      const http = this.httpServers.get(serverName);
      if (http) {
        http.status = "running";
        http.lastError = undefined;
      }
    }
  }

  private async getOrStartServer(serverName: string): Promise<McpConnection> {
    const existing = this.servers.get(serverName);
    if (existing) {
      return existing;
    }
    const existingHttp = this.httpServers.get(serverName);
    if (existingHttp) {
      return existingHttp;
    }

    const config = getMcpServerConfigs()[serverName];
    if (!config) {
      throw new Error(`找不到 MCP 服务配置：${serverName}`);
    }
    if (config.enabled === false) {
      throw new Error(`MCP 服务已禁用：${serverName}`);
    }
    if ((config.transport ?? "stdio") === "http") {
      return this.createHttpServer(serverName, config);
    }
    if (!config.command) {
      throw new Error(`MCP 服务 ${serverName} 缺少 command 配置。`);
    }

    const workspaceRoot = getWorkspaceRoot();
    const cwd = resolveCwd(config, workspaceRoot);
    const child = cp.spawn(resolveToken(config.command, workspaceRoot), (config.args ?? []).map((arg) => resolveToken(arg, workspaceRoot)), {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ...resolveEnv(config.env, workspaceRoot)
      }
    });

    const server: RunningMcpServer = {
      name: serverName,
      transport: "stdio",
      process: child,
      nextId: 1,
      buffer: "",
      pending: new Map(),
      initialized: false,
      status: "starting",
      discoveredTools: this.discoveredToolsByServer.get(serverName) ?? [],
      discoveredResources: this.discoveredResourcesByServer.get(serverName) ?? [],
      discoveredPrompts: this.discoveredPromptsByServer.get(serverName) ?? []
    };
    this.servers.set(serverName, server);
    this.statusByServer.set(serverName, "starting");
    this.appendLog(serverName, "info", "正在启动 stdio MCP 服务。", `${config.command} ${(config.args ?? []).join(" ")}`.trim());

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(server, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.appendLog(serverName, "warning", "MCP stderr 输出。", compactLogDetail(chunk.toString("utf8")));
    });
    child.on("exit", () => {
      if (this.servers.get(serverName) === server) {
        this.servers.delete(serverName);
        this.statusByServer.set(serverName, "stopped");
      }
      server.status = "stopped";
      this.appendLog(serverName, "info", "stdio MCP 服务已退出。");
      for (const pending of server.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP 服务已退出：${serverName}`));
      }
      server.pending.clear();
    });
    child.on("error", (error) => {
      if (this.servers.get(serverName) === server) {
        this.servers.delete(serverName);
        this.statusByServer.set(serverName, "error");
      }
      server.status = "error";
      server.lastError = error.message;
      this.lastErrorsByServer.set(serverName, error.message);
      this.appendLog(serverName, "error", "stdio MCP 服务启动失败。", error.message);
      for (const pending of server.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      server.pending.clear();
    });

    await this.initialize(server);
    server.status = "running";
    this.statusByServer.set(serverName, "running");
    this.lastErrorsByServer.delete(serverName);
    this.appendLog(serverName, "info", "stdio MCP 服务已连接。");
    return server;
  }

  private async createHttpServer(serverName: string, config: McpServerConfig): Promise<HttpMcpServer> {
    if (!config.url) {
      throw new Error(`HTTP MCP 服务 ${serverName} 缺少 url 配置。`);
    }
    const server: HttpMcpServer = {
      name: serverName,
      transport: "http",
      url: config.url.replace(/\/+$/, ""),
      headers: config.headers ?? {},
      nextId: 1,
      initialized: false,
      status: "starting",
      discoveredTools: this.discoveredToolsByServer.get(serverName) ?? [],
      discoveredResources: this.discoveredResourcesByServer.get(serverName) ?? [],
      discoveredPrompts: this.discoveredPromptsByServer.get(serverName) ?? []
    };
    this.httpServers.set(serverName, server);
    this.statusByServer.set(serverName, "starting");
    this.appendLog(serverName, "info", "正在连接 HTTP MCP 服务。", server.url);
    await this.initialize(server);
    server.status = "running";
    this.statusByServer.set(serverName, "running");
    this.lastErrorsByServer.delete(serverName);
    this.appendLog(serverName, "info", "HTTP MCP 服务已连接。");
    return server;
  }

  private async initialize(server: McpConnection): Promise<void> {
    if (server.initialized) {
      return;
    }
    await this.request(server, "initialize", {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: {
        roots: {},
        sampling: {},
        elicitation: {}
      },
      clientInfo: {
        name: "Patchlane",
        version: "0.0.1"
      }
    });
    this.notify(server, "notifications/initialized", {});
    server.initialized = true;
    this.appendLog(server.name, "info", "MCP initialize 完成。");
  }

  private request(server: McpConnection, method: string, params: unknown, options: McpRequestOptions = {}): Promise<unknown> {
    if (server.transport === "http") {
      return this.requestHttp(server, method, params, options);
    }
    this.appendLog(server.name, "info", `发送 MCP 请求：${method}`);
    const id = server.nextId++;
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        server.pending.delete(id);
        options.signal?.removeEventListener("abort", abort);
        this.appendLog(server.name, "error", `MCP 请求超时：${method}`);
        reject(new Error(`MCP 请求超时：${method}`));
      }, REQUEST_TIMEOUT_MS);

      const abort = () => {
        clearTimeout(timer);
        server.pending.delete(id);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      const resolveOnce = (value: unknown) => {
        options.signal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const rejectOnce = (error: Error) => {
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      };

      if (options.signal?.aborted) {
        abort();
        return;
      }

      server.pending.set(id, { resolve: resolveOnce, reject: rejectOnce, timer });
      options.signal?.addEventListener("abort", abort, { once: true });
      server.process.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
    });
  }

  private async requestHttp(server: HttpMcpServer, method: string, params: unknown, options: McpRequestOptions = {}): Promise<unknown> {
    this.appendLog(server.name, "info", `发送 HTTP MCP 请求：${method}`);
    const response = await this.sendHttp(server, {
      jsonrpc: "2.0",
      id: server.nextId++,
      method,
      params
    }, options);
    if (!response) {
      return undefined;
    }
    if (response.error) {
      this.appendLog(server.name, "error", `HTTP MCP 请求失败：${method}`, response.error.message);
      throw new Error(response.error.message || `HTTP MCP 请求失败：${response.error.code ?? "unknown"}`);
    }
    this.appendLog(server.name, "info", `HTTP MCP 请求完成：${method}`);
    return response.result;
  }

  private notify(server: McpConnection, method: string, params: unknown): void {
    if (server.transport === "http") {
      void this.sendHttp(server, {
        jsonrpc: "2.0",
        method,
        params
      }).catch(() => undefined);
      return;
    }
    server.process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, "utf8");
  }

  private async sendHttp(
    server: HttpMcpServer,
    message: Record<string, unknown>,
    options: McpRequestOptions = {}
  ): Promise<JsonRpcResponse | undefined> {
    const expectedId = typeof message.id === "number" ? message.id : undefined;
    const method = typeof message.method === "string" ? message.method : "notification";
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);
    const abort = () => controller.abort();

    if (options.signal?.aborted) {
      clearTimeout(timeout);
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
      const response = await fetch(server.url, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          "MCP-Protocol-Version": SUPPORTED_PROTOCOL_VERSIONS[0],
          ...server.headers
        },
        body: JSON.stringify(message)
      });
      if (response.status === 202) {
        return undefined;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(text.trim() || `HTTP MCP 请求失败：${response.status} ${response.statusText}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (/text\/event-stream/i.test(contentType)) {
        this.appendLog(server.name, "info", `HTTP MCP 使用 SSE 响应：${method}`);
        if (expectedId === undefined) {
          await response.body?.cancel().catch(() => undefined);
          return undefined;
        }
        return await readSseJsonRpcResponse(response, expectedId, controller.signal);
      }

      const text = await response.text().catch(() => "");
      if (!text.trim()) {
        return undefined;
      }
      return parseHttpMcpPayload(text, expectedId);
    } catch (error) {
      if (timedOut) {
        throw new Error(`HTTP MCP 请求超时：${method}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  private handleStdout(server: RunningMcpServer, chunk: Buffer): void {
    server.buffer += chunk.toString("utf8");
    const lines = server.buffer.split(/\r?\n/);
    server.buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let response: JsonRpcResponse;
      try {
        response = JSON.parse(trimmed) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof response.id !== "number") {
        continue;
      }
      const pending = server.pending.get(response.id);
      if (!pending) {
        continue;
      }
      server.pending.delete(response.id);
      clearTimeout(pending.timer);
      if (response.error) {
        this.appendLog(server.name, "error", "MCP 请求失败。", response.error.message);
        pending.reject(new Error(response.error.message || `MCP 请求失败：${response.error.code ?? "unknown"}`));
      } else {
        this.appendLog(server.name, "info", "MCP 请求完成。");
        pending.resolve(response.result);
      }
    }
  }

  private appendLog(serverName: string, level: McpServerLogEntry["level"], message: string, detail?: string): void {
    const logs = this.logsByServer.get(serverName) ?? [];
    logs.push({
      time: new Date().toISOString(),
      level,
      server: serverName,
      message,
      detail
    });
    this.logsByServer.set(serverName, logs.slice(-40));
  }
}

function parseToolInput(input?: string | Record<string, unknown>): Record<string, unknown> {
  if (!input) {
    return {};
  }
  if (typeof input === "object") {
    return input;
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { input: parsed };
  } catch {
    return { input: trimmed };
  }
}

function compactLogDetail(value: string): string {
  const compacted = value.replace(/\r?\n\s*/g, "\n").trim();
  if (compacted.length <= 1200) {
    return compacted;
  }
  return `${compacted.slice(0, 1200)}\n... 已截断`;
}

function formatMcpContent(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result ?? "");
  }
  const object = result as Record<string, unknown>;
  const content = object.content;
  if (Array.isArray(content)) {
    const parts = content.map((item) => {
      if (!item || typeof item !== "object") {
        return String(item ?? "");
      }
      const block = item as Record<string, unknown>;
      if (typeof block.text === "string") {
        return block.text;
      }
      if (typeof block.data === "string") {
        return block.data;
      }
      return JSON.stringify(block, null, 2);
    }).filter(Boolean);
    if (parts.length > 0) {
      return parts.join("\n\n");
    }
  }
  return JSON.stringify(result, null, 2);
}

function formatMcpResourceContent(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result ?? "");
  }
  const object = result as Record<string, unknown>;
  const contents = Array.isArray(object.contents) ? object.contents : Array.isArray(object.content) ? object.content : [];
  const parts = contents.map((item) => {
    if (!item || typeof item !== "object") {
      return String(item ?? "");
    }
    const block = item as Record<string, unknown>;
    const uri = typeof block.uri === "string" ? block.uri : undefined;
    const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
    const text = typeof block.text === "string"
      ? block.text
      : typeof block.blob === "string"
        ? `[二进制资源，Base64 长度 ${block.blob.length}]`
        : JSON.stringify(block, null, 2);
    return [
      uri ? `资源：${uri}` : undefined,
      mimeType ? `类型：${mimeType}` : undefined,
      text
    ].filter(Boolean).join("\n");
  }).filter(Boolean);
  return parts.length > 0 ? parts.join("\n\n") : JSON.stringify(result, null, 2);
}

function formatMcpPromptContent(result: unknown): string {
  if (!result || typeof result !== "object") {
    return String(result ?? "");
  }
  const object = result as Record<string, unknown>;
  const messages = Array.isArray(object.messages) ? object.messages : [];
  const description = typeof object.description === "string" ? object.description.trim() : "";
  const parts = messages.map((item) => {
    if (!item || typeof item !== "object") {
      return String(item ?? "");
    }
    const message = item as Record<string, unknown>;
    const role = typeof message.role === "string" ? message.role : "message";
    const content = extractMcpPromptMessageContent(message.content);
    return [`### ${role}`, content].filter(Boolean).join("\n");
  }).filter(Boolean);
  return [
    description ? `说明：${description}` : "",
    ...parts
  ].filter(Boolean).join("\n\n") || JSON.stringify(result, null, 2);
}

function extractMcpPromptMessageContent(value: unknown): string {
  if (!value || typeof value !== "object") {
    return String(value ?? "");
  }
  if (Array.isArray(value)) {
    return value.map(extractMcpPromptMessageContent).filter(Boolean).join("\n\n");
  }
  const block = value as Record<string, unknown>;
  if (typeof block.text === "string") {
    return block.text;
  }
  if (typeof block.data === "string") {
    return block.data;
  }
  return JSON.stringify(block, null, 2);
}

function normalizeMcpTools(value: unknown): McpDiscoveredTool[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const object = value as Record<string, unknown>;
  const rawTools = Array.isArray(object.tools) ? object.tools : [];
  const tools: McpDiscoveredTool[] = [];
  for (const item of rawTools) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const tool = item as Record<string, unknown>;
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) {
      continue;
    }
    const title = typeof tool.title === "string" ? tool.title.trim() : "";
    const description = typeof tool.description === "string" ? tool.description.trim() : "";
    tools.push({
      name,
      label: title || name,
      description: description || `MCP 工具 ${name}`,
      inputSchema: tool.inputSchema
    });
  }
  return tools;
}

function normalizeMcpResources(value: unknown): McpDiscoveredResource[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const object = value as Record<string, unknown>;
  const rawResources = Array.isArray(object.resources) ? object.resources : [];
  const resources: McpDiscoveredResource[] = [];
  for (const item of rawResources) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const resource = item as Record<string, unknown>;
    const uri = typeof resource.uri === "string" ? resource.uri.trim() : "";
    if (!uri) {
      continue;
    }
    resources.push({
      uri,
      name: typeof resource.name === "string" && resource.name.trim() ? resource.name.trim() : uri,
      description: typeof resource.description === "string" ? resource.description.trim() : undefined,
      mimeType: typeof resource.mimeType === "string" ? resource.mimeType.trim() : undefined
    });
  }
  return resources;
}

function normalizeMcpPrompts(value: unknown): McpDiscoveredPrompt[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const object = value as Record<string, unknown>;
  const rawPrompts = Array.isArray(object.prompts) ? object.prompts : [];
  const prompts: McpDiscoveredPrompt[] = [];
  for (const item of rawPrompts) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const prompt = item as Record<string, unknown>;
    const name = typeof prompt.name === "string" ? prompt.name.trim() : "";
    if (!name) {
      continue;
    }
    const title = typeof prompt.title === "string" ? prompt.title.trim() : "";
    prompts.push({
      name,
      label: title || name,
      description: typeof prompt.description === "string" ? prompt.description.trim() : undefined,
      arguments: normalizeMcpPromptArguments(prompt.arguments)
    });
  }
  return prompts;
}

function normalizeMcpPromptArguments(value: unknown): McpDiscoveredPromptArgument[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const args: McpDiscoveredPromptArgument[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const argument = item as Record<string, unknown>;
    const name = typeof argument.name === "string" ? argument.name.trim() : "";
    if (!name) {
      continue;
    }
    const normalized: McpDiscoveredPromptArgument = {
      name,
      required: argument.required === true
    };
    const description = typeof argument.description === "string" ? argument.description.trim() : "";
    if (description) {
      normalized.description = description;
    }
    args.push(normalized);
  }
  return args.length > 0 ? args : undefined;
}

function getWorkspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("调用 MCP 前请先打开一个工作区文件夹。");
  }
  return folder.uri.fsPath;
}

function resolveCwd(config: McpServerConfig, workspaceRoot: string): string {
  if (!config.cwd) {
    return workspaceRoot;
  }
  const resolved = path.resolve(workspaceRoot, resolveToken(config.cwd, workspaceRoot));
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`MCP cwd 必须位于当前工作区内：${config.cwd}`);
  }
  return resolved;
}

function resolveEnv(env: Record<string, string> | undefined, workspaceRoot: string): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, resolveToken(value, workspaceRoot)]));
}

function resolveToken(value: string, workspaceRoot: string): string {
  return value.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
}
