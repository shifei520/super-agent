import "dotenv/config";
import type { ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from "node:readline/promises";
import { weatherTool, calculatorTool } from "./tools";
import { agentLoop, BudgetState } from "./agent/loop";
import { allTools } from "./tools";
import { ToolRegistry } from "./tools/tool-registry";
import { MCPClient } from "./tools/mcp-client";

const toolRegistry = new ToolRegistry();
toolRegistry.register(...allTools);
for (const tool of toolRegistry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? "可并发" : "串行",
    tool.isReadOnly ? "只读" : "读写",
  ].join(", ");
  console.log(`  - ${tool.name}（${flags}）`);
}

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
      console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (err) {
      console.log(
        `  MCP 连接失败: ${err instanceof Error ? err.message : err}`,
      );
      console.log("  降级为 Mock MCP...");
    }
  }
}

const budget: BudgetState = {
  used: 0,
  limit: 1000000,
};

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

const ds = createOpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = ds.chat("deepseek-flash");

async function main() {
  await connectMCP();
  console.log(`\n已注册 ${toolRegistry.getAll().length} 个工具：`);
  for (const tool of toolRegistry.getAll()) {
    const isMCP = tool.name.startsWith("mcp__");
    const flags = [
      isMCP ? "MCP" : "内置",
      tool.isConcurrencySafe ? "可并发" : "串行",
    ].join(", ");
    console.log(`  - ${tool.name}（${flags}）`);
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const messages: ModelMessage[] = [];

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

    messages.push({
      role: "user",
      content: trimedQuery,
    });

    await agentLoop(model, toolRegistry, messages, SYSTEM, budget);
  }

  console.log("Bye!");
  rl.close();
}

console.log('Super Agent v0.3 — Fuses (type "exit" to quit)\n');
await main();
