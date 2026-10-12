import type { ModelMessage } from "ai";
import type { ToolRegistry } from "../tools/tool-registry";
import type { UsageTracker } from "../usage/tracker";
import { MemoryStore } from "../memory/store";

/**
 * 斜杠命令的执行上下文——由 main 在每轮循环里提供。
 * handler 通过它拿到「活」的运行时状态（消息历史、工具注册表、用量统计等），
 * 命令模块本身不持有任何全局状态，便于单测与增删命令。
 */
export interface CommandContext {
  /** 当前对话消息（就地 push 的同一个数组引用） */
  messages: ModelMessage[];
  toolRegistry: ToolRegistry;
  usageTracker: UsageTracker;
  /** /context 展示用的模型元信息 */
  model: {
    name: string;
    id: string;
    windowTokens: number;
  };
  /** 已构建好的 system prompt，用于估算其 token 占用 */
  systemPrompt: string;
  /**
   * 记忆存储。记忆段是通过 prompt pipe 注入 system prompt 的，
   * 已经算在 systemPrompt 里，/context 会把它扣出来单独画一片。
   */
  memoryStore: MemoryStore;
}

/**
 * 命令处理器：命中并处理返回 true，不属于自己的命令返回 false 交给下一个。
 */
export type CommandHandler = (cmd: string, ctx: CommandContext) => boolean;

/**
 * 把多个 handler 串成一条责任链，返回一个总入口。
 * 第一个返回 true 的 handler 即「吃掉」这条命令，链停止。
 */
export function createDispatcher(handlers: CommandHandler[]): CommandHandler {
  return (cmd, ctx) => {
    for (const h of handlers) {
      if (h(cmd, ctx)) return true;
    }
    return false;
  };
}
