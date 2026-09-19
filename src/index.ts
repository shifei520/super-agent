import "dotenv/config";
import type { ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from "node:readline/promises";
import { weatherTool, calculatorTool } from "./tools";
import { agentLoop, BudgetState } from "./agent/loop";
import { allTools } from "./tools";
import { ToolRegistry } from "./tools/tool-registry";

const toolRegistry = new ToolRegistry();
toolRegistry.register(...allTools);
console.log(`已注册 ${toolRegistry.getAll().length} 个工具：`);
for (const tool of toolRegistry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? "可并发" : "串行",
    tool.isReadOnly ? "只读" : "读写",
  ].join(", ");
  console.log(`  - ${tool.name}（${flags}）`);
}

const budget: BudgetState = {
  used: 0,
  limit: 10000,
};

const SYSTEM = `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;

const ds = createOpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = ds.chat("deepseek-flash");

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

const messages: ModelMessage[] = [];

async function main() {
  while (true) {
    let q: string;
    try {
      q = await rl.question("请输入你的问题：");
    } catch {
      // stdin 关闭（EOF / Ctrl+D / 管道结束）时 question 会 reject，正常退出
      break;
    }

    const trimedQuery = q.trim();
    if (!trimedQuery || trimedQuery === "exit") {
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
console.log('试试输入："测试死循环"、"测试重试"、"测试预算" 看三层防护效果\n');
await main();
