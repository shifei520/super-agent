import { streamText, type ModelMessage } from "ai";

import {
  detect,
  recordCall,
  recordResult,
  resetHistory,
} from "./loop-detection.js";
import { isRetryable, calculateDelay, sleep } from "./retry.js";

const MAX_STEPS = 10;
const MAX_RETRIES = 3;

export interface BudgetState {
  used: number;
  limit: number;
}

export const agentLoop = async (
  model: any,
  tools: any,
  messages: ModelMessage[],
  system: string,
  budget: BudgetState,
) => {
  resetHistory();
  for (let step = 1; step <= MAX_STEPS; step++) {
    console.log(`\n--- Step ${step} ---`);

    // 消费完整流：边输出边记录有没有工具调用
    let hasToolCall = false;
    let shouldBreak = false;
    let lastToolCall: { name: string; params: unknown } | null = null;
    let stepsResult: Awaited<ReturnType<typeof streamText>["steps"]> = [];
    let fullText = "";
    let stepUsage: Awaited<ReturnType<typeof streamText>["usage"]> | null =
      null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = streamText({
          model,
          system,
          messages,
          tools,
          // DeepSeek V4 的 thinking 模式默认开启，且带 tools 时要求回传 reasoning_content，
          // 而 @ai-sdk/openai 不支持该字段 → 直接禁用 thinking 规避 400
          providerOptions: {
            openai: { reasoningEffort: "none" },
          },
          maxRetries: 0,
          onError: () => {},
        });

        for await (const part of result.stream) {
          switch (part.type) {
            case "text-delta":
              process.stdout.write(part.text);
              fullText += part.text;
              break;
            case "tool-call":
              hasToolCall = true;
              lastToolCall = { name: part.toolName, params: part.input };
              console.log(
                `\n  [调用工具: ${part.toolName}(${JSON.stringify(part.input)})]`,
              );

              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  [循环检测: ${detection.message}]`);
                if (detection.level === "critical") {
                  shouldBreak = true;
                } else {
                  messages.push({
                    role: "user",
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              recordCall(part.toolName, part.input);

              break;
            case "tool-result":
              console.log(`  [工具返回: ${JSON.stringify(part.output)}]`);
              if (lastToolCall) {
                recordResult(
                  lastToolCall.name,
                  lastToolCall.params,
                  part.output,
                );
              }
              break;
            case "error":
              throw part.error;
          }
        }
        stepsResult = await result.steps;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error)) {
          throw error;
        }
        const delay = calculateDelay(attempt);
        console.log(
          `  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`,
        );
        await sleep(delay);
        hasToolCall = false;
        stepsResult = [];
        lastToolCall = null;
        fullText = "";
        shouldBreak = false;
      }
    }

    if (shouldBreak) {
      console.log("\n[循环检测触发，Agent 已停止]");
      break;
    }

    // 流消费完后，把本轮产生的所有新消息（assistant 文本 + tool_call + tool_result）
    // 从每个 step 里收集，写回历史

    messages.push(...stepsResult.flatMap((s) => s.response.messages));

    // 更新预算
    const inputTokens = stepUsage?.inputTokens || 0;
    const outputTokens = stepUsage?.outputTokens || 0;
    budget.used += inputTokens + outputTokens;
    const pct = Math.round((budget.used / budget.limit) * 100);
    console.log(`  [Token] ${budget.used}/${budget.limit} (${pct}%)`);
    if (budget.used >= budget.limit) {
      console.log("\n[预算超支，强制停止]");
      break;
    }

    // 没有工具调用 = 模型给出了最终回答，结束
    if (!hasToolCall) {
      if (fullText) console.log();
      return;
    }

    console.log("\n  → 模型还在工作，继续下一步...");
  }

  console.log("\n[达到最大步数限制，强制停止]");
};
