import { jsonSchema } from "ai";
import { MCPClient } from "./mcp-client";

// 生产环境阈值：约 12.5k token（按 ~4 字符/token 估算），
// 既给单文件阅读留足空间，又防止单次工具结果挤爆上下文
const DEFAULT_MAX_RESULT_CHARS = 50000;

const truncateResult = (
  text: string,
  maxChars: number = DEFAULT_MAX_RESULT_CHARS,
) => {
  if (text.length <= maxChars) {
    return text;
  }
  const headSize = maxChars * 0.6;
  const tailSize = maxChars - headSize;

  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const truncatedSize = text.length - maxChars;

  return `${head}\n\n... [省略 ${truncatedSize} 字符] ...\n\n${tail}`;
};

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (params: any) => Promise<unknown>;

  // 元数据——给 Agent Loop 做决策用
  isConcurrencySafe?: boolean; // 能否并行调用
  isReadOnly?: boolean; // 是否只读
  maxResultChars?: number; // 最大返回字符数
  shouldDefer?: boolean; // 是否延迟调用
  searchHint?: string; // 搜索提示词，帮助 ToolSearch 匹配
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();
  private exclusiveLock = false; // 是否有排他锁，防止并行调用
  private concurrencyCount = 0; // 并发调用计数
  private waitQueue: Array<() => void> = []; // 阻塞等待中的 resolve 函数
  private mcpClients: MCPClient[] = [];
  private discoveredTools: Set<string> = new Set();

  register(...tools: ToolDefinition[]) {
    tools.forEach((tool) => {
      this.tools.set(tool.name, tool);
    });
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  private async acquireConcurrent() {
    if (this.exclusiveLock) {
      await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    }
    this.concurrencyCount++;
  }

  private async releaseConcurrent() {
    this.concurrencyCount--;
    if (this.concurrencyCount <= 0) {
      this.drainQueue();
    }
  }

  private async acquireExclusiveLock() {
    while (this.exclusiveLock || this.concurrencyCount > 0) {
      await new Promise<void>((resolve) => this.waitQueue.push(resolve));
    }
    this.exclusiveLock = true;
  }

  private async releaseExclusiveLock() {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  private drainQueue() {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) {
      resolve();
    }
  }

  searchTools(query: string): ToolDefinition[] {
    const q = query.trim();
    const results: ToolDefinition[] = [];

    const names = query.includes(",")
      ? q
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
      : [query];

    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool && tool.name !== "tool_search") {
        results.push(tool);
        this.discoveredTools.add(tool.name);
      }
    }
    return results;
  }

  getActiveTools(): ToolDefinition[] {
    return this.getAll().filter((tool) => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false;
      }
      return true;
    });
  }

  getDeferredToolSummary(): string {
    const deferred = this.getAll().filter((tool) => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name);
    });

    if (deferred.length === 0) return "";

    const lines = deferred.map((t) => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : "";
      return `  - ${t.name}${hint}`;
    });

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join("\n")}`;
  }
  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0;
    let deferred = 0;

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length;
      const tokens = Math.ceil(schemaSize / 4);

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens;
      } else {
        active += tokens;
      }
    }

    return { active, deferred, total: active + deferred };
  }

  toAISDKFormat(): Record<string, any> {
    const tools = this.getActiveTools();
    const result: Record<string, any> = {};
    tools.forEach((tool: ToolDefinition) => {
      const isSafe = tool.isConcurrencySafe || false;
      const register = this;

      const name = tool.name;

      result[name] = {
        name: name,
        inputSchema: jsonSchema(tool.parameters),
        execute: async (params: any) => {
          if (isSafe) {
            await register.acquireConcurrent();
            console.log(`  [并发] ${name} 获取共享锁`);
          } else {
            await register.acquireExclusiveLock();
            console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
          }

          try {
            const raw = await tool.execute(params);
            const text =
              typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, tool.maxResultChars);
          } finally {
            if (isSafe) {
              await register.releaseConcurrent();
            } else {
              await register.releaseExclusiveLock();
            }
          }
        },
      };
    });
    return result;
  }

  async registerMCPServer(serverName: string, client: MCPClient) {
    await client.connect();
    this.mcpClients.push(client);

    const tools = await client.listTools();

    const registered: string[] = [];

    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`;
      if (this.tools.has(prefixedName)) continue;

      const originalName = tool.name;

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 10000,
        execute: async (input: any) => {
          return client.callTool(originalName, input);
        },
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
      });

      registered.push(prefixedName);
    }

    return registered;
  }

  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close();
    }
    this.mcpClients = [];
  }
}
