import { ToolDefinition, ToolRegistry } from "./tool-registry";

export function createToolSearchTool(toolRegistry: ToolRegistry): ToolDefinition {
  return {
    name: "tool_search",
    description:
      "加载延迟工具。传入工具名（从系统提示的延迟工具列表中选取），加载后即可在下一轮直接调用该工具",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名',
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async ({ query }: { query: string }) => {
      const results = toolRegistry.searchTools(query);
      if (results.length === 0) return `没有找到匹配 "${query}" 的工具`;
      // 完整定义已通过 searchTools 的副作用注入 discoveredTools，
      // 下一轮 toAISDKFormat() 会把这些工具作为一等公民工具交给模型，
      // 这里只需轻量确认，避免在 tool_result 里重复 schema 浪费 token
      const names = results.map((t) => t.name).join(", ");
      return `已加载工具: ${names}。现在可以直接调用它们。`;
    },
  }
}