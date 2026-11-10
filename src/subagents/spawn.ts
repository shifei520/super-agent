import { ModelMessage, streamText } from "ai";
import { ToolRegistry } from "../tools/tool-registry";
import { SubAgentRegistry } from "./registry";
import { SpawnRequest, SubAgentRun } from "./types";

export interface SpawnContext {
  model: any;
  toolRegistry: ToolRegistry;
  agentRegistry: SubAgentRegistry;
  buildSystem: () => string;
  currentDepth: number;
}
const EXCLUDED_TOOLS = new Set(["spawn_agent"]);

const AGENT_COLORS = [
  "\x1b[36m", // cyan
  "\x1b[33m", // yellow
  "\x1b[35m", // magenta
  "\x1b[32m", // green
  "\x1b[34m", // blue
];
const RESET = "\x1b[0m";

function agentTag(index: number, runId: string): string {
  const color = AGENT_COLORS[index % AGENT_COLORS.length];
  return `${color}[Agent-${index + 1}:${runId}]${RESET}`;
}

export async function spawnAgent(
  req: SpawnRequest,
  ctx: SpawnContext,
  index = 0,
): Promise<string> {
  if (!req.task?.trim()) return '[spawn] 拒绝: 任务不能为空';
  const admission = ctx.agentRegistry.canSpawn(ctx.currentDepth);
  if (!admission.ok) return `[spawn] 拒绝: ${admission.reason}`;
  const maxSteps = 30;

  const runId = ctx.agentRegistry.generateId();
  const messages: ModelMessage[] = [{ role: "user", content: req.task }];
  const tag = agentTag(index, runId);
  const run: SubAgentRun = {
    id: runId,
    task: req.task,
    status: "running",
    depth: ctx.currentDepth + 1,
    startedAt: new Date().toISOString(),
  };
  ctx.agentRegistry.register(run);
  const ac = new AbortController();
  const timeout = req.timeout ?? ctx.agentRegistry.getConfig().defaultTimeout;
  const timer = setTimeout(() => ac.abort(), timeout);

  console.log(`  ${tag} 运行中: ${req.task.replace(/[\r\n\x1b]/g, ' ').slice(0, 50)}`);
  try {
    let step = 0;
    const system = ctx.buildSystem() +
      '\n\n[子 Agent 模式] 你是一个被派出去执行具体任务的子 Agent。直接完成任务并输出结论，保持简洁。' +
      '\n当你需要同时获取多个独立信息时（比如读多个文件、搜多个关键词），尽可能在一次回复中并行调用多个工具，不要一个个串行调。';
    while (step < maxSteps) {
      step++;
      const isLastStep = step >= maxSteps;
      if (isLastStep) {
        messages.push({
          role: "user",
          content:
            "你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。",
        });
      }

      const result = streamText({
        model: ctx.model,
        system,
        messages,
        // 每轮重新取工具，使 tool_search 新发现的工具下一轮即可调用。
        tools: ctx.toolRegistry.toAISDKFormat({
          quiet: true,
          excludeTools: EXCLUDED_TOOLS,
          allowedTools: req.tools ? new Set(req.tools) : undefined,
          abortSignal: ac.signal,
        }),
        toolChoice: isLastStep ? "none" : "auto",
        // DeepSeek V4 的 thinking 模式默认开启，且带 tools 时要求回传 reasoning_content，
        // 而 @ai-sdk/openai 不支持该字段 → 直接禁用 thinking 规避 400
        providerOptions: {
          openai: { reasoningEffort: "none", parallelToolCalls: true },
        },
        maxRetries: 0,
        onError: () => {},
        abortSignal: ac.signal,
      });
      let hasToolCall = false;

      for await (const part of result.stream) {
        if (part.type === "tool-call") {
          hasToolCall = true;
        }
        if (part.type === 'error') throw part.error;
      }
      ac.signal.throwIfAborted();
      const stepsResult = await result.steps;
      messages.push(...stepsResult.flatMap((s) => s.response.messages));
      if (!hasToolCall) break;
    }
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    let fullResult = "(无输出)";
    if (lastAssistant) {
      if (typeof lastAssistant.content === "string") {
        fullResult = lastAssistant.content;
      } else if (Array.isArray(lastAssistant.content)) {
        fullResult =
          lastAssistant.content
            .filter((p: any) => p.type === "text")
            .map((p: any) => p.text)
            .join("") || "(无输出)";
      }
    }

    ctx.agentRegistry.complete(runId, fullResult);
    console.log(`  ${tag} 完成 ✓ (${fullResult.length} 字符)`);
    return fullResult;
  } catch (err: any) {
    const isAbort = err?.name === "AbortError" || ac.signal.aborted;
    const errorMsg = isAbort
      ? `执行超时 (${timeout / 1000}s)`
      : err?.message || String(err);
    ctx.agentRegistry.fail(runId, errorMsg, isAbort);
    console.log(`  ${tag} ${isAbort ? "超时" : "失败"} ✗: ${errorMsg}`);
    if (isAbort) {
      const partial = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      if (partial) {
        const text =
          typeof partial.content === "string"
            ? partial.content
            : Array.isArray(partial.content)
              ? partial.content
                  .filter((p: any) => p.type === "text")
                  .map((p: any) => p.text)
                  .join("")
              : "";
        if (text) return `[部分结果] ${text}`;
      }
    }
    return `[sub-agent 执行失败] ${errorMsg}`;
  } finally {
    clearTimeout(timer);
  }
}

export async function spawnParallel(
  requests: SpawnRequest[],
  ctx: SpawnContext,
): Promise<Array<{ task: string; result: string }>> {
  const maxConcurrent = ctx.agentRegistry.getConfig().maxConcurrency;
  const activeCount = ctx.agentRegistry.getActiveRuns().length;
  const available = maxConcurrent - activeCount;
  if (available <= 0) {
    return requests.map((r) => ({
      task: r.task,
      result: `[spawn] 拒绝: 已达最大并发数 ${maxConcurrent}`,
    }));
  }
  const toRun = requests.slice(0, available);
  const rejected = requests.slice(available);
  if (rejected.length > 0) {
    console.log(
      `  ⚠ 请求 ${requests.length} 个子 Agent，但最大并发为 ${maxConcurrent}，只执行前 ${toRun.length} 个`,
    );
  }
  console.log(`\n  ┌─ 派发 ${toRun.length} 个子 Agent 并行执行 ─┐`);
  const results = await Promise.all(
    toRun.map(async (req, i) => {
      const result = await spawnAgent(req, ctx, i);
      return { task: req.task, result };
    }),
  );
  for (const r of rejected) {
    results.push({
      task: r.task,
      result: `[spawn] 拒绝: 超出最大并发数 ${maxConcurrent}，本次未执行`,
    });
  }
  console.log(`  └─ 派发结束 (${toRun.length}/${requests.length} 已执行) ─┘\n`);
  return results;
}
