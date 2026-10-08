import "dotenv/config";
import type { ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from "node:readline/promises";
import { agentLoop, BudgetState } from "./agent/loop";
import { allTools } from "./tools";
import { ToolDefinition, ToolRegistry } from "./tools/tool-registry";
import { MCPClient } from "./tools/mcp-client";
import { SessionStore } from "./session/store";
import {
  coreRules,
  deferredTools,
  PromptBuilder,
  PromptContext,
  sessionContext,
  toolGuide,
} from "./context/prompt-builder";
import { formatUsage, UsageTracker } from "./usage/tracker";

const toolRegistry = new ToolRegistry();
toolRegistry.register(...allTools);

async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const { execSync } = await import("node:child_process");
    execSync("echo test", { stdio: "ignore" });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    console.log("\n连接 GitHub MCP Server...");
    try {
      const client = new MCPClient(
        "pnpm",
        ["dlx", "@modelcontextprotocol/server-github"],
        { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
      );
      const tools = await toolRegistry.registerMCPServer("github", client);
      return;
    } catch (err) {
      console.log(
        `  MCP 连接失败: ${err instanceof Error ? err.message : err}`,
      );
      console.log("  降级为 Mock MCP...");
    }
  }
}

// 模拟额外的 MCP 工具（演示工具膨胀问题）
function registerSimulatedTools() {
  const simulatedTools: ToolDefinition[] = [
    // Notion MCP 模拟
    {
      name: "mcp__notion__search_pages",
      description: "[MCP:notion] 搜索 Notion 页面",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      shouldDefer: true,
      searchHint: "notion search pages documents",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ query }: any) =>
        JSON.stringify([{ title: `Mock: ${query}`, id: "page-001" }]),
    },
    {
      name: "mcp__notion__create_page",
      description: "[MCP:notion] 创建 Notion 页面",
      parameters: {
        type: "object",
        properties: { title: { type: "string" }, content: { type: "string" } },
        required: ["title"],
      },
      shouldDefer: true,
      searchHint: "notion create page document write",
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ title }: any) => `已创建页面: ${title}`,
    },
    {
      name: "mcp__notion__list_databases",
      description: "[MCP:notion] 列出 Notion 数据库",
      parameters: { type: "object", properties: {}, required: [] },
      shouldDefer: true,
      searchHint: "notion list databases tables",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async () =>
        JSON.stringify([
          { title: "项目追踪", id: "db-001" },
          { title: "知识库", id: "db-002" },
        ]),
    },

    // Playwright MCP 模拟
    {
      name: "mcp__browser__navigate",
      description: "[MCP:browser] 导航到指定 URL",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
      shouldDefer: true,
      searchHint: "browser navigate open url webpage",
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ url }: any) => `已导航到 ${url}`,
    },
    {
      name: "mcp__browser__screenshot",
      description: "[MCP:browser] 对当前页面截图",
      parameters: { type: "object", properties: {} },
      shouldDefer: true,
      searchHint: "browser screenshot capture page",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async () => "[screenshot data]",
    },
    {
      name: "mcp__browser__click",
      description: "[MCP:browser] 点击页面元素",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
      shouldDefer: true,
      searchHint: "browser click element button",
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ selector }: any) => `已点击 ${selector}`,
    },
    {
      name: "mcp__browser__fill",
      description: "[MCP:browser] 在输入框中填写内容",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" }, value: { type: "string" } },
        required: ["selector", "value"],
      },
      shouldDefer: true,
      searchHint: "browser fill input form text",
      isConcurrencySafe: false,
      isReadOnly: false,
      execute: async ({ selector, value }: any) =>
        `已在 ${selector} 填写 ${value}`,
    },
    {
      name: "mcp__browser__get_text",
      description: "[MCP:browser] 获取页面文本内容",
      parameters: {
        type: "object",
        properties: { selector: { type: "string" } },
        required: ["selector"],
      },
      shouldDefer: true,
      searchHint: "browser get text content extract",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ selector }: any) => `Mock text content of ${selector}`,
    },

    // Supabase MCP 模拟
    {
      name: "mcp__supabase__query",
      description: "[MCP:supabase] 执行 SQL 查询",
      parameters: {
        type: "object",
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
      shouldDefer: true,
      searchHint: "database sql query select",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ sql }: any) =>
        JSON.stringify([{ id: 1, name: "mock_row", sql }]),
    },
    {
      name: "mcp__supabase__list_tables",
      description: "[MCP:supabase] 列出数据库所有表",
      parameters: { type: "object", properties: {} },
      shouldDefer: true,
      searchHint: "database list tables schema",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async () => JSON.stringify(["users", "orders", "products"]),
    },
    {
      name: "mcp__supabase__describe_table",
      description: "[MCP:supabase] 查看表结构",
      parameters: {
        type: "object",
        properties: { table: { type: "string" } },
        required: ["table"],
      },
      shouldDefer: true,
      searchHint: "database describe table columns schema",
      isConcurrencySafe: true,
      isReadOnly: true,
      execute: async ({ table }: any) =>
        JSON.stringify({
          table,
          columns: [
            { name: "id", type: "integer" },
            { name: "name", type: "text" },
          ],
        }),
    },
  ];

  toolRegistry.register(...simulatedTools);
  return simulatedTools.length;
}

const toolSearchTool: ToolDefinition = {
  name: "tool_search",
  description:
    "加载延迟工具。传入工具名（从系统提示的延迟工具列表中选取），加载后即可在下一轮直接调用该工具",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名',
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ query }: { query: string }) => {
    const results = toolRegistry.searchTools(query);
    if (results.length === 0) return `没有找到匹配 "${query}" 的工具`;
    // 完整定义已通过 searchTools 的副作用注入 discoveredTools，
    // 下一轮 toAISDKFormat() 会把这些工具作为一等公民工具交给模型，
    // 这里只需轻量确认，避免在 tool_result 里重复 schema 浪费 token
    const names = results.map((t) => t.name).join(", ");
    return `已加载工具: ${names}。现在可以直接调用它们。`;
  },
};
toolRegistry.register(toolSearchTool);

const budget: BudgetState = {
  used: 0,
  limit: 1000000,
};

const ds = createOpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = ds.chat("deepseek-flash");

async function main() {
  const usageTracker = new UsageTracker(".usage/today.jsonl");
  await connectMCP();

  const simCount = registerSimulatedTools();
  console.log(
    `  已注册 ${simCount} 个模拟 MCP 工具（Notion/Browser/Supabase）`,
  );

  const allCount = toolRegistry.getAll().length;
  const activeTools = toolRegistry.getActiveTools();
  const estimate = toolRegistry.countTokenEstimate();

  console.log(`\n=== 工具统计 ===`);
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个（非延迟）`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
  console.log(
    `  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`,
  );

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // session持久化
  const isContinue = process.argv.includes("--continue");
  const sessionId = "default";
  const store = new SessionStore(sessionId);

  let messages: ModelMessage[] = [];
  // 消息索引 → 创建毫秒时间戳（供 applyDefense 的 TTL 清理用）。
  // 恢复的历史消息没有可靠时间戳，不记录即视为未知、永不被 TTL 清理。
  const msgTimestamps = new Map<number, number>();
  if (isContinue && store.exists()) {
    messages = store.load();
    console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
  } else {
    console.log(`[Session] 新会话`);
  }

  // Prompt Pipe 组装 system prompt
  const builder = new PromptBuilder()
    .pipe("coreRules", coreRules())
    .pipe("toolGuide", toolGuide())
    .pipe("deferredTools", deferredTools())
    .pipe("sessionContext", sessionContext());

  const promptCtx: PromptContext = {
    toolCount: toolRegistry.getActiveTools().length,
    deferredToolSummary: toolRegistry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId,
  };

  const SYSTEM = builder.build(promptCtx);
  // Debug: 显示 Prompt Pipe 各模块状态
  builder.debug(promptCtx);

  while (true) {
    let q: string;
    try {
      q = await rl.question("You：");
    } catch {
      // stdin 关闭（EOF / Ctrl+D / 管道结束）时 question 会 reject，正常退出
      break;
    }

    const trimedQuery = q.trim();
    if (!trimedQuery || trimedQuery === "exit") {
      rl.close();
      await toolRegistry.closeAllMCP();
      break;
    }

    const userMsg: ModelMessage = {
      role: "user",
      content: trimedQuery,
    };

    messages.push(userMsg);
    msgTimestamps.set(messages.length - 1, Date.now());
    store.append(userMsg);

    const beforeLen = messages.length;
    const turnStart = usageTracker.stepCount;
    await agentLoop(
      model,
      toolRegistry,
      messages,
      SYSTEM,
      budget,
      msgTimestamps,
      usageTracker,
    );

    console.log(`  [用量·本轮] ${formatUsage(usageTracker.totals(turnStart))}`);

    // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
    const newMessages = messages.slice(beforeLen);
    store.appendAll(newMessages);
  }

  console.log(`\n[用量·累计] ${formatUsage(usageTracker.totals())}`);
  console.log("Bye!");
  rl.close();
}

console.log('Super Agent v0.3 — Fuses (type "exit" to quit)\n');
await main();
