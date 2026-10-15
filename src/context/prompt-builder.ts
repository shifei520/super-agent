import { MemoryStore } from "../memory/store";
import { SqliteVectorStore } from "../rag/sqlite-store";

export interface PromptContext {
  toolCount: number;
  deferredToolSummary: string;
  sessionMessageCount: number;
  sessionId: string;
}

type PipeFn = (ctx: PromptContext) => string | null;

export class PromptBuilder {
  private pipes: Array<{ name: string; fn: PipeFn }> = [];

  pipe(name: string, fn: PipeFn) {
    this.pipes.push({ name, fn });
    return this;
  }

  /**
   * 逐个 pipe 求值，返回各段的字符数。
   * /context 用它把 system prompt 拆成分类切片（尤其是记忆段），debug 也复用。
   * 注意：pipe 会被重新执行一次，所以 pipe 内部不要有副作用。
   */
  sections(ctx: PromptContext): Array<{ name: string; chars: number }> {
    return this.pipes.map(({ name, fn }) => {
      const result = fn(ctx);
      return { name, chars: result !== null ? result.length : 0 };
    });
  }

  build(ctx: PromptContext): string {
    const sections: string[] = [];
    for (const { fn } of this.pipes) {
      const result = fn(ctx);
      if (result !== null) {
        sections.push(result);
      }
    }

    return sections.join("\n\n");
  }

  debug(ctx: PromptContext): void {
    console.log("\n=== Prompt Pipe Debug ===");
    for (const { name, chars } of this.sections(ctx)) {
      const status = chars > 0 ? `[ON] ${chars} chars` : "[OFF]";
      console.log(`  ${name}: ${status}`);
    }
    console.log("========================\n");
  }
}

// ── 预定义的 Pipe ────────────────────────────────

export function coreRules(): PipeFn {
  return () => `你是 Super Agent，一个有工具调用能力的 AI 助手。
你的行为准则：
- 先读文件再修改，不要凭记忆编辑
- 不要加没被要求的功能
- 工具调用失败时，换一个思路而不是重复同样的操作
- 回答要简洁直接`;
}

export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null;
    return `你有 ${ctx.toolCount} 个工具可用。需要操作本地文件时使用内置工具，需要访问外部服务时使用 MCP 工具。`;
  };
}

export function deferredTools(): PipeFn {
  return (ctx) => {
    if (!ctx.deferredToolSummary) return null;
    return `如果你需要的工具不在当前列表中，使用 tool_search 工具搜索。${ctx.deferredToolSummary}`;
  };
}

export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null;
    return `[会话信息] 当前会话 ${ctx.sessionId}，已有 ${ctx.sessionMessageCount} 条历史消息。`;
  };
}

export function memoryContext(memoryStore: MemoryStore): (ctx: PromptContext) => string | null {
  return () => memoryStore.buildPromptSection();
}

export function ragContext(vectorStore: SqliteVectorStore): (ctx: PromptContext) => string | null {
  return () => {
    const size = vectorStore.size();
    if (size === 0) return null;
    const sources = vectorStore.sources();
    return `[知识库] 已导入 ${size} 个文档片段（来源: ${sources.join(', ')}）。使用 rag_search 工具搜索知识库。`;
  };
}
