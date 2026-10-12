import type { CommandHandler } from ".";
import {
  buildContextSnapshot,
  renderContextView,
  renderUsageView,
} from "../context/view";

/**
 * /context —— 终端里画 context 占用矩阵（参考 Claude Code）。
 * 本地展示，不进对话历史、不调用模型。
 */
const contextHandler: CommandHandler = (cmd, ctx) => {
  if (cmd !== "/context") return false;
  const snapshot = buildContextSnapshot({
    modelName: ctx.model.name,
    modelId: ctx.model.id,
    windowTokens: ctx.model.windowTokens,
    systemPromptChars: ctx.systemPrompt.length,
    // 记忆段寄生在 system prompt 内，单独扣出来画一片，避免重复计算
    memoryChars: ctx.memoryStore.buildPromptSection().length,
    memoryCount: ctx.memoryStore.list().length,
    toolTokens: ctx.toolRegistry.countTokenEstimate().active,
    messages: ctx.messages,
  });
  console.log(renderContextView(snapshot));
  return true;
};

/** /usage —— 累计 token 用量、cache 命中率、节省金额。 */
const usageHandler: CommandHandler = (cmd, ctx) => {
  if (cmd !== "/usage") return false;
  console.log(renderUsageView(ctx.usageTracker));
  return true;
};

export const contextCommands: CommandHandler[] = [
  contextHandler,
  usageHandler,
];
