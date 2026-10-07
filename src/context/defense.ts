import type { ModelMessage } from "ai";
import {
  textToolResultTool,
  toolResultOutputToText,
} from "./tool-result-output";
import { MODEL_CONTEXT_WINDOW } from "./config";

function countMessageChars(message: ModelMessage): number {
  let chars = 0;
  if (typeof message.content === "string") {
    return message.content.length;
  }
  if (!Array.isArray(message.content)) return chars;

  for (const part of message.content) {
    if ("text" in part && typeof part.text === "string") {
      chars += part.text.length;
    } else if ("output" in part) {
      chars += toolResultOutputToText(part.output).length;
    } else if ("input" in part) {
      chars += JSON.stringify(part.input)?.length ?? 0;
    }
  }
  return chars;
}

function countMessagesChars(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += countMessageChars(message);
  }
  return chars;
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  const chars = countMessagesChars(messages);
  // 4 chars per token, with 1.2x safety factor for Chinese
  return Math.ceil((chars / 4) * 1.2);
}

// ── Layer 1: Token Estimation ────────────────────────

export class TokenTracker {
  private lastPreciseCount = 0; // 上次 API 返回的精确值
  private pendingChars = 0;

  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens;
    this.pendingChars = 0; // 精确值到了，清零增量
  }

  addMessage(message: ModelMessage) {
    this.pendingChars += countMessageChars(message);
  }

  addMessages(messages: ModelMessage[]): void {
    for (const message of messages) this.addMessage(message);
  }

  replaceMessages(before: ModelMessage[], after: ModelMessage[]): void {
    this.pendingChars += countMessagesChars(after) - countMessagesChars(before);
  }

  get estimatedTokens(): number {
    return this.lastPreciseCount + Math.ceil(this.pendingChars / 4);
  }
}

// ── Layer 2: Dynamic Tool Result Truncation ──────────

interface TruncationConfig {
  maxSingleResult: number;
  contextBudgetChars: number;
}

const DEFAULT_TRUNCATION: TruncationConfig = {
  maxSingleResult: MODEL_CONTEXT_WINDOW * 0.5 * 2, // 50% 窗口，2 chars/token
  contextBudgetChars: MODEL_CONTEXT_WINDOW * 0.75 * 4, // 75% 窗口，4 chars/token
};

export function truncateToolResults(
  messages: ModelMessage[],
  config = DEFAULT_TRUNCATION,
): { messages: ModelMessage[]; truncated: number; compacted: number } {
  let truncated = 0;
  let compacted = 0;

  // Pass 1: 单条截断——超过窗口 50% 的工具结果做 Head/Tail 分割
  let result = messages.map((msg) => {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) return msg;

    const newContent = msg.content.map((part: any) => {
      if (!part.output) return part;

      const outputText = toolResultOutputToText(part.output);
      if (outputText.length < config.maxSingleResult) return part;

      truncated++;
      const maxChars = config.maxSingleResult;
      const headSize = Math.floor(0.6 * maxChars);
      const tailSize = Math.floor(0.4 * maxChars);
      const headChars = outputText.slice(0, headSize);
      const tailChars = outputText.slice(-tailSize);

      return {
        ...part,
        output: textToolResultTool(
          `${headChars}\n\n[truncated: ${outputText.length} → ${maxChars} chars]\n\n${tailChars}`,
        ),
      };
    });

    return {
      ...msg,
      content: newContent,
    };
  });

  // Pass 2: 总量预算——如果总字符数还超 75%，从最老的 tool result 开始清理
  let totalChars = result.reduce((sum, msg) => {
    if (typeof msg.content === "string") return sum + msg.content.length;

    if (Array.isArray(msg.content)) {
      return (
        sum +
        msg.content.reduce(
          (s, c) =>
            s +
            (c.output
              ? toolResultOutputToText(c.output).length
              : c?.text?.length || 0),
          0,
        )
      );
    }
    return sum;
  }, 0);

  if (totalChars > config.contextBudgetChars) {
    for (
      let i = 0;
      i < result.length && totalChars > config.contextBudgetChars;
      i++
    ) {
      const msg = result[i];
      if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
      const toolName = (msg.content[0] as any)?.toolName || "unknown";
      const oldSize = msg.content.reduce(
        (s: number, p: any) =>
          s + (p.output ? toolResultOutputToText(p.output).length : 0),
        0,
      );
      result[i] = {
        ...msg,
        content: msg.content.map((p: any) => ({
          ...p,
          output: textToolResultTool(
            `[compacted: ${toolName} output removed to free context]`,
          ),
        })),
      };
      totalChars -= oldSize;
      compacted++;
    }
  }
  return { messages: result, truncated, compacted };
}

// ── Layer 3: TTL Pruning ─────────────────────────────

interface TTLConfig {
  softTTLMs: number;
  hardTTLMs: number;
  keepHeadTail: number;
}

const DEFAULT_TTL: TTLConfig = {
  softTTLMs: 5 * 60 * 1000, // 5 minutes
  hardTTLMs: 10 * 60 * 1000, // 10 minutes
  keepHeadTail: 1500, // chars to keep in soft prune
};

export interface PruneResult {
  messages: ModelMessage[];
  softPruned: number;
  hardPruned: number;
}
export function ttlPrune(
  messages: ModelMessage[],
  timestamps: Map<number, number>, // 消息索引 → 创建时间戳
  config: TTLConfig = DEFAULT_TTL,
): PruneResult {
  const now = Date.now();
  let softPruned = 0;
  let hardPruned = 0;
  const result = messages.map((msg, idx) => {
    // 只修剪 tool 结果，user/assistant 消息永不修剪
    if (msg.role !== "tool") return msg;

    const timestamp = timestamps.get(idx);
    if (!timestamp) return msg;

    const diff = now - timestamp;

    // 保留错误经验——失败的工具结果永不修剪
    const outputText = (msg.content as any[])
      .map((p: any) => (p.output ? toolResultOutputToText(p.output) : ""))
      .join("");
    const isError = /error|失败|不存在|denied|refused|timeout/i.test(
      outputText,
    );
    if (isError) return msg;

    // Hard clear: replace entire content with placeholder
    if (diff >= config.hardTTLMs) {
      hardPruned++;
      const toolName = (msg.content[0] as any)?.toolName || "unknown";
      return {
        ...msg,
        content: msg.content.map((part) => ({
          ...part,
          output: textToolResultTool(`[tool result expired: ${toolName}]`),
        })),
      };
    }
    // Soft prune: keep head + tail, replace middle
    if (diff >= config.softTTLMs) {
      return {
        ...msg,
        content: msg.content.map((part: any) => {
          if (!part.output) return part;
          const outputText = toolResultOutputToText(part.output);
          if (outputText.length <= config.keepHeadTail * 2) return part;

          softPruned++;
          const head = outputText.slice(0, config.keepHeadTail);
          const tail = outputText.slice(-config.keepHeadTail);
          const removed = outputText.length - config.keepHeadTail * 2;

          return {
            ...part,
            output: textToolResultTool(
              `${head}\n\n[soft pruned: ${removed} chars removed, content older than ${Math.round(config.softTTLMs / 60000)}min]\n\n${tail}`,
            ),
          };
        }),
      };
    }

    return msg;
  });

  return { messages: result, softPruned, hardPruned };
}

// ── Combined Defense ─────────────────────────────────
export interface DefenseResult {
  messages: ModelMessage[];
  tokenEstimate: number;
  // truncated: number;
  // compacted: number;
  softPruned: number;
  hardPruned: number;
}

export function applyDefense(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
): DefenseResult {
  // 这一层我们不需要，也因为我们前面做了工具的maxResultChars截断和上下文压缩的的layer1层级Microcompact
  // Layer 2: truncate oversized tool results
  // const trunc = truncateToolResults(messages);
  // let result = trunc.messages;

  // Layer 3: TTL prune old tool results
  const prune = ttlPrune(messages, timestamps);
  let result = prune.messages;

  // Layer 1: estimate final token count
  const tokenEstimate = estimateMessageTokens(result);

  return {
    messages: result,
    tokenEstimate,
    // truncated: trunc.truncated,
    // compacted: trunc.compacted,
    softPruned: prune.softPruned,
    hardPruned: prune.hardPruned,
  };
}
