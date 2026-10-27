import { ModelMessage } from "ai";
import { CommandHandler } from ".";
import { SkillLoader } from "../skills/loader";
import { agentLoop } from "../agent/loop";

export function createSkillCommands(skillLoader: SkillLoader, activeSkills: Set<string>): CommandHandler[] {
  return [
    // /skill list
    (cmd, ctx) => {
      if (cmd !== '/skill' && cmd !== '/skill list' && cmd !== 'skill list') return false;

      const skills = skillLoader.list();
      if (skills.length === 0) {
        console.log('\n[skills] 没有找到任何 skill。在 .skills/ 目录下创建 skill-name/SKILL.md 即可。\n');
        return true;
      }

      console.log(`\n[skills] 共 ${skills.length} 个可用：`);
      for (const s of skills) {
        const active = activeSkills.has(s.name) ? ' ✓ 已激活' : '';
        console.log(`  /${s.name} — ${s.description}${active}`);
        if (s.whenToUse) console.log(`    适用场景: ${s.whenToUse}`);
      }
      console.log('');
      return true;
    },
    // /skill load <name>
    (cmd, ctx) => {
      const match = cmd.match(/^\/skill\s+load\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];
      const skill = skillLoader.get(name);
      if (!skill) {
        console.log(`\n[skills] 找不到 skill: ${name}\n`);
        return true;
      }
      activeSkills.add(name);
      console.log(`\n[skills] 已激活: ${name} — ${skill.description}\n`);
      return true;
    },
    // /skill unload <name>
    (cmd, ctx) => {
      const match = cmd.match(/^\/skill\s+unload\s+(\S+)$/);
      if (!match) return false;
      const name = match[1];
      if (!activeSkills.has(name)) {
        console.log(`\n[skills] ${name} 未激活\n`);
        return true;
      }
      activeSkills.delete(name);
      console.log(`\n[skills] 已卸载: ${name}\n`);
      return true;
    },
    // /<skill-name> — 直接用 /code-review 激活并触发
    async (cmd, ctx) => {
      if (!cmd.startsWith('/')) return false;
      const [name, ...rest] = cmd.slice(1).split(/\s+/);
      const skill = skillLoader.get(name);
      if (!skill) return false;

      // 激活后 skillContext pipe 会把正文注入 system prompt，本轮及后续轮次都生效
      activeSkills.add(name);
      console.log(`\n[skills] 激活 ${name}，开始执行...`);

      // ctx.systemPrompt 是激活前构建的，需重新 build 才包含刚激活的 skill
      const system = ctx.rebuildSystemPrompt();

      // user 消息只说明调用了哪个 skill 及参数，正文不进对话历史
      const args = rest.join(' ');
      const content = args
        ? `使用 Skill「${name}」：${args}`
        : `使用 Skill「${name}」，按其流程开始执行。`;

      const userMsg: ModelMessage = { role: 'user', content };
      ctx.messages.push(userMsg);
      ctx.msgTimestamps.set(ctx.messages.length - 1, Date.now());
      ctx.sessionStore.append(userMsg);

      const beforeLen = ctx.messages.length;
      await agentLoop(
        ctx.llm,
        ctx.toolRegistry,
        ctx.messages,
        system,
        ctx.budget,
        ctx.msgTimestamps,
        ctx.usageTracker,
      );

      // 持久化 agentLoop 本轮新增的 assistant/tool 消息
      ctx.sessionStore.appendAll(ctx.messages.slice(beforeLen));
      console.log(`[skills] ${name} 执行完成\n`);
      return true;
    },
  ]
}