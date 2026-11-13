// 模型运行时参数（上下文窗口 + 请求兼容选项），由 main 在加载 config 后注入。
// 独立成模块以避免 agent/loop.ts 与 context/defense.ts 之间的循环依赖。
export interface ModelRuntime {
  /** 模型上下文窗口（token），用于压缩阈值与截断预算 */
  contextWindow: number;
  /** 是否禁用 thinking/reasoning（@ai-sdk/openai 无法回传 reasoning_content） */
  disableReasoning: boolean;
}

const runtime: ModelRuntime = {
  contextWindow: Number(process.env.CONTEXT_WINDOW) || 1_000_000,
  disableReasoning: true,
};

export function setModelRuntime(next: ModelRuntime): void {
  Object.assign(runtime, next);
}

export function getContextWindow(): number {
  return runtime.contextWindow;
}

type ProviderOptions = Record<string, string | number | boolean>;

/**
 * 组装 OpenAI 兼容端点的 providerOptions。
 * DeepSeek V4 的 thinking 默认开启且带 tools 时要求回传 reasoning_content，
 * 而 @ai-sdk/openai 不支持该字段 → 用 reasoningEffort: "none" 规避 400。
 * 非 DeepSeek 模型把 config.model.disableReasoning 设为 false 即可不发送该字段。
 */
export function openAICompatProviderOptions(
  extra: ProviderOptions = {},
): { openai: ProviderOptions } {
  const reasoning: ProviderOptions = runtime.disableReasoning
    ? { reasoningEffort: 'none' }
    : {};
  return { openai: { ...reasoning, ...extra } };
}
