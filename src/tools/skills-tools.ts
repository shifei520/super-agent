import { SkillLoader } from "../skills/loader";
import { ToolDefinition } from "./tool-registry";

export function createSkillTool(skillLoader: SkillLoader, activeSkills: Set<string>): ToolDefinition {
  return {
    name: 'use_skill',
    description: '激活并使用一个 skill，传入skill的名称，注意skill名称不是斜杠开头',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'skill 名称，例如 code-review（不带斜杠）' },
      },
      required: ['name']
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    maxResultChars: 15000,
    execute: async ({ name: rawName }) => {
      // 兜底：模型仍可能传 "/code-review"，去掉前导斜杠和空白
      const name = String(rawName).trim().replace(/^\/+/, '');
      const skill = skillLoader.get(name)
      if (!skill) {
        const available = skillLoader.list().map(s => s.name).join(', ') || '无';
        return `Skill ${name} 不存在。可用的 skill：${available}`;
      }

      // 将 skill 内容注入到下一轮对话
      activeSkills.add(name);
      return `已激活 skill: ${name}。现在可以按照该 skill 的指令执行任务。`;
    }
  }
}