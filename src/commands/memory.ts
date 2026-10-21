import { ModelMessage } from 'ai';
import type { CommandHandler } from './index.js';
import { agentLoop } from '../agent/loop.js';

const DREAM_PROMPT = [
  '请对记忆库做一次完整的整理（dream），按以下四个阶段执行：',
  '',
  '**阶段 1：定位** — 用 memory lint 扫描全库（lint 结果已包含内容预览和问题清单，不需要再逐条 read）。',
  '**阶段 2：整理** — 根据 lint 报告直接操作：',
  '  - 路径过期且长期未用的，直接 memory delete（传 filename）删掉',
  '  - 同名重复的，用 memory save 保存合并后的版本（同名自动覆盖），再 delete 多余的',
  '  - 内容仍然有效但描述不准确的，用 memory save 覆盖更新',
  '**阶段 3：报告** — 用一段文字总结这次整理做了什么。',
  '',
  '注意：memory 的 read 和 delete 都需要传 filename 参数（如 project_deploy-process.md），不是 name。lint 报告里已经有 filename 了，直接用。',
].join('\n');

export const memoryCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== '/memory' && cmd !== 'memory') return false;
    const entries = ctx.memoryStore!.list();
    console.log(`\n[记忆系统] 共 ${entries.length} 条记忆`);
    for (const e of entries) console.log(`  [${e.type}] ${e.name} — ${e.description}`);
    console.log('');
    return true;
  },

  (cmd, ctx) => {
    if (!cmd.startsWith('/memory search ')) return false;
    const query = cmd.slice('/memory search '.length).trim();
    const results = ctx.memoryStore!.search(query);
    console.log(`\n[记忆搜索] "${query}" → ${results.length} 条结果`);
    for (const e of results) console.log(`  [${e.type}] ${e.name} — ${e.description}`);
    console.log('');
    return true;
  },

  (cmd, ctx) => {
    if (!cmd.startsWith('/lint')) return false;
    const reports = ctx.memoryStore!.lint();
    if (reports.length === 0) {
      console.log('\n[lint] 记忆库健康，没有发现问题。\n');
      return true;
    }
    console.log(`\n[lint] 记忆库 ${reports.length} 条有警告：`);
    for (const r of reports) {
      console.log(`  📁 ${r.entry.filePath.split('/').pop()}  [${r.entry.type}] ${r.entry.name}`);
      for (const issue of r.issues) console.log(`     • ${issue.kind}: ${issue.message}`);
    }
    console.log('');

    return true
  },

  async (cmd, ctx) => {
    if (!cmd.startsWith('/dream')) return false;
    console.log('\n[dream] 开始记忆整理...');
    const userMsg: ModelMessage = { role: 'user', content: DREAM_PROMPT };
    ctx.messages.push(userMsg);
    ctx.msgTimestamps.set(ctx.messages.length - 1, Date.now());
    ctx.sessionStore.append(userMsg);

    const beforeLen = ctx.messages.length;
    await agentLoop(
      ctx.llm,
      ctx.toolRegistry,
      ctx.messages,
      ctx.systemPrompt,
      ctx.budget,
      ctx.msgTimestamps,
      ctx.usageTracker,
    );

    // 持久化 agentLoop 本轮新增的 assistant/tool 消息
    ctx.sessionStore.appendAll(ctx.messages.slice(beforeLen));
    console.log('[dream] 整理完成\n');
    return true;
  },
];
