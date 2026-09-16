import "dotenv/config";
import type { ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from "node:readline/promises";
import { weatherTool, calculatorTool } from "./tools/utility-tools";
import { agentLoop } from "./agent/loop";

const tools = {
  get_weather: weatherTool,
  calculator: calculatorTool,
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

    await agentLoop(model, tools, messages, SYSTEM);
  }

  console.log("Bye!");
  rl.close();
}

console.log('Super Agent v0.2 — Agent Loop (type "exit" to quit)\n');
await main();
