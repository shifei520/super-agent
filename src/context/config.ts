// 模型上下文窗口（token）。默认 1M。
// 可用环境变量 CONTEXT_WINDOW 覆盖（换模型或测试时调小以便快速触发压缩）。
// 独立成模块以避免 agent/loop.ts 与 context/defense.ts 之间的循环依赖。
export const MODEL_CONTEXT_WINDOW =
  Number(process.env.CONTEXT_WINDOW) || 1000000;
