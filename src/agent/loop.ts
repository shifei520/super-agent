import { stepCountIs, streamText, type ModelMessage } from "ai";

const MAX_STEPS = 10;

export const agentLoop = async (
  model: any,
  tools: any,
  messages: ModelMessage[],
  system: string,
) => {
  for (let step = 1; step <= MAX_STEPS; step++) {
    console.log(`\n--- Step ${step} ---`);

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
    });

    // 消费完整流：边输出边记录有没有工具调用
    let hasToolCall = false;
    for await (const part of result.stream) {
      switch (part.type) {
        case "text-delta":
          process.stdout.write(part.text);
          break;
        case "tool-call":
          hasToolCall = true;
          console.log(
            `\n  [调用工具: ${part.toolName}(${JSON.stringify(part.input)})]`,
          );
          break;
        case "tool-result":
          console.log(`  [工具返回: ${JSON.stringify(part.output)}]`);
          break;
        case "error":
          throw part.error;
      }
    }

    // 流消费完后，把本轮产生的所有新消息（assistant 文本 + tool_call + tool_result）
    // 从每个 step 里收集，写回历史
    const steps = await result.steps;
    messages.push(...steps.flatMap((s) => s.response.messages));

    // 没有工具调用 = 模型给出了最终回答，结束
    if (!hasToolCall) {
      console.log();
      return;
    }

    console.log("\n  → 模型还在工作，继续下一步...");
  }

  console.log("\n[达到最大步数限制，强制停止]");
};
