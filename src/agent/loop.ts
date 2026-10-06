import { streamText, type ModelMessage } from "ai";

import {
  detect,
  recordCall,
  recordResult,
  resetHistory,
} from "./loop-detection.js";
import { isRetryable, calculateDelay, sleep } from "./retry.js";
import { microcompact, summarize } from "../context/compressor.js";
import { ToolRegistry } from "../tools/tool-registry.js";

const MAX_STEPS = 10;
const MAX_RETRIES = 3;

// ── 上下文压缩阈值 ────────────────────────────────────
// 模型上下文窗口（token）。默认 deepseek-flash = 64k。
// 可用环境变量 CONTEXT_WINDOW 覆盖（换模型或测试时调小以便快速触发压缩）。
const MODEL_CONTEXT_WINDOW = Number(process.env.CONTEXT_WINDOW) || 1000000;
// 触发压缩的占比：真实输入 token 超过窗口 80% 时启动 Layer 1
const COMPRESS_THRESHOLD_RATIO = 0.8;
// Layer 2 触发占比：microcompact 后仍超过窗口 92% 才上调用的 LLM 摘要
const SUMMARIZE_THRESHOLD_RATIO = 0.92;

export interface BudgetState {
  used: number;
  limit: number;
}

export const agentLoop = async (
  model: any,
  toolRegistry: ToolRegistry,
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
          tools: toolRegistry.toAISDKFormat(),
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

    // ── 上下文压缩（级联：先 Layer 1 本地清空，仍超阈值才 Layer 2 LLM 摘要）──
    // 判断依据用 API 返回的真实 inputTokens（含 system + tools schema + messages），
    // 比本地字符估算准确，也不会漏掉 system/工具定义的开销。
    // 本步的 stepUsage.inputTokens 反映"本次请求发送时"的上下文大小，用它判断
    // "下一步是否需要先压缩再发送"。上下文单调增长、每步重新判断，故一个 step 的
    // 统计滞后可接受（阈值已留 20% 缓冲）。
    const compressAt = Math.floor(
      MODEL_CONTEXT_WINDOW * COMPRESS_THRESHOLD_RATIO,
    );
    const summarizeAt = Math.floor(
      MODEL_CONTEXT_WINDOW * SUMMARIZE_THRESHOLD_RATIO,
    );
    const contextTokens = stepUsage?.inputTokens ?? 0;
    console.log();
    console.log(
      `  [上下文] 真实输入 ${contextTokens} tokens / 窗口 ${MODEL_CONTEXT_WINDOW} (micro@${compressAt}, summary@${summarizeAt})`,
    );

    // Layer 1: microcompact（零成本，优先执行）
    if (contextTokens > compressAt) {
      const { messages: compacted, cleared } = microcompact(messages);
      if (cleared > 0) {
        // 原地替换，保持 messages 数组引用不变（外部持久化逻辑依赖同一引用）
        messages.length = 0;
        messages.push(...compacted);
        console.log(`  [压缩·micro] 清空 ${cleared} 条旧 tool 结果`);
      }
    }

    // Layer 2: LLM 摘要（成本高，仅当仍逼近窗口上限时兜底）。
    // 若本步 microcompact 已把上下文压下去，下一步的真实 inputTokens 会回落，
    // Layer 2 自然不再触发——用真实值做级联，无需对 micro 的效果做本地近似。
    if (contextTokens > summarizeAt) {
      console.log(
        `  [压缩·summary] 输入 ${contextTokens} tokens 超过窗口 ${Math.round(SUMMARIZE_THRESHOLD_RATIO * 100)}%，触发 LLM 摘要...`,
      );
      const result = await summarize(model, messages);
      if (result.compressedCount > 0) {
        messages.length = 0;
        messages.push(...result.messages);
        console.log(
          `  [压缩·summary] 压缩 ${result.compressedCount} 条 → 1 条摘要`,
        );
      }
    }

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
