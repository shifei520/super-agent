import "dotenv/config";
import type { ModelMessage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createInterface } from "node:readline/promises";
import { agentLoop, BudgetState } from "./agent/loop";
import { allTools, createSkillTool, createToolSearchTool } from "./tools";
import { ToolRegistry } from "./tools/tool-registry";
import { MCPClient } from "./tools/mcp-client";
import { SessionStore } from "./session/store";
import {
  coreRules,
  deferredTools,
  PromptBuilder,
  PromptContext,
  ragContext,
  sessionContext,
  toolGuide,
} from "./context/prompt-builder";
import { formatUsage, UsageTracker } from "./usage/tracker";
import { createDispatcher, type CommandContext } from "./commands";
import { contextCommands } from "./commands/context";
import { MemoryStore } from "./memory/store";
import { createMemoryTool } from "./tools/memory-tools";
import { memoryCommands } from "./commands/memory";
import { SqliteVectorStore } from "./rag/sqlite-store";
import { createDashScopeEmbedder } from "./rag/embedder";
import { createRagTools } from "./tools/rag-tools";
import { SkillLoader } from "./skills/loader";
import { createSkillCommands } from "./commands/skills";
import { PluginManager } from "./plugins/manager";
import { PluginDefinition } from "./plugins/types";
import { supabasePlugin } from "./plugins/supabase-plugin";
import { createPluginCommands } from "./commands/plugin";
import { ChannelGateway } from "./channels/gateway";
import { FeiShuChannel } from "./channels/feishu";
// 用量控制
const budget: BudgetState = {
  used: 0,
  limit: 1000000,
};

const ds = createOpenAI({
  baseURL: "https://api.deepseek.com",
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = ds.chat("deepseek-flash");

// ── SKILL ────────────────────────────────
const skillLoader = new SkillLoader(".")
const loadedSkills = skillLoader.load();
const activeSkills = new Set<string>();
// ── Registry ────────────────────────────────
const toolRegistry = new ToolRegistry();
toolRegistry.register(...allTools);
toolRegistry.register(createToolSearchTool(toolRegistry));
toolRegistry.register(createSkillTool(skillLoader, activeSkills));
// ── Memory ────────────────────────────────
const memoryStore = new MemoryStore('.')
toolRegistry.register(createMemoryTool(memoryStore))
// ── RAG ────────────────────────────────
const vectorStore = new SqliteVectorStore('knowledge.db');
const embedFn = createDashScopeEmbedder(process.env.QWEN_API_KEY!)
toolRegistry.register(...createRagTools(vectorStore, embedFn));
// ── Plugins ────────────────────────────────
const pluginManager = new PluginManager(toolRegistry);
const availablePlugins = new Map<string, PluginDefinition>([
  ['supabase', supabasePlugin],
]);
// ── Channels ────────────────────────────────
// 注意：ChannelGateway 在 main() 里构造，因为它依赖 builder / makePromptCtx。
const feishuChannel = new FeiShuChannel({
  appId: process.env.FEISHU_APP_ID!,
  appSecret: process.env.FEISHU_APP_SECRET!,
})

async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const { execSync } = await import("node:child_process");
    execSync("echo test", { stdio: "ignore" });
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    console.log("\n连接 GitHub MCP Server...");
    try {
      const client = new MCPClient(
        "pnpm",
        ["dlx", "@modelcontextprotocol/server-github"],
        { GITHUB_PERSONAL_ACCESS_TOKEN: githubToken },
      );
      const tools = await toolRegistry.registerMCPServer("github", client);
      return;
    } catch (err) {
      console.log(
        `  MCP 连接失败: ${err instanceof Error ? err.message : err}`,
      );
      console.log("  降级为 Mock MCP...");
    }
  }
}


// /context 展示用的模型元信息
const MODEL_ID = "deepseek-flash";
const MODEL_NAME = "DeepSeek Flash";
// DeepSeek 对话模型上下文窗口 1000K tokens
const MODEL_WINDOW_TOKENS = 1000_000;

async function main() {
  const usageTracker = new UsageTracker(".usage/today.jsonl");
  await connectMCP();

  // 启动时自动加载插件
  console.log('  加载插件...');
  for (const [name, def] of availablePlugins) {
    try {
      const tools = await pluginManager.load(def);
      console.log(`  ✓ ${name} — ${tools.length} 个工具`);
    } catch {
      console.log(`  ✗ ${name} — 加载失败`);
    }
  }

  const allCount = toolRegistry.getAll().length;
  const activeTools = toolRegistry.getActiveTools();
  const estimate = toolRegistry.countTokenEstimate();

  console.log(`\n=== 工具统计 ===`);
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个（非延迟）`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
  console.log(
    `  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`,
  );

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // session持久化
  const isContinue = process.argv.includes("--continue");
  const sessionId = "default1";
  const sessionStore = new SessionStore(sessionId);

  let messages: ModelMessage[] = [];
  // 消息索引 → 创建毫秒时间戳（供 applyDefense 的 TTL 清理用）。
  // 恢复的历史消息没有可靠时间戳，不记录即视为未知、永不被 TTL 清理。
  const msgTimestamps = new Map<number, number>();
  if (isContinue && sessionStore.exists()) {
    messages = sessionStore.load();
    console.log(`[Session] 恢复会话，${messages.length} 条历史消息`);
  } else {
    console.log(`[Session] 新会话`);
  }

    // Prompt Pipe 组装 system prompt
  const builder = new PromptBuilder()
    .pipe("coreRules", coreRules())
    .pipe("toolGuide", toolGuide())
    .pipe("deferredTools", deferredTools())
    .pipe('memoryContext', () => memoryStore.buildPromptSection())
    .pipe('ragContext', ragContext(vectorStore))
    .pipe('skillContext', () => skillLoader.buildPromptSection(activeSkills))
    .pipe("sessionContext", sessionContext());

  function makePromptCtx(): PromptContext {
    return {
      toolCount: toolRegistry.getActiveTools().length,
      deferredToolSummary: toolRegistry.getDeferredToolSummary(),
      sessionMessageCount: messages.length,
      sessionId,
    };
  }

  // 通道消息走自己的会话表（gateway.sessions），与终端 messages 无关，
  // 所以这里单独组 ctx，不把终端的会话长度/ID 带过去。
  const channelGateway = new ChannelGateway({
    toolRegistry,
    model,
    budget,
    buildSystem: () =>
      builder.build({
        toolCount: toolRegistry.getActiveTools().length,
        deferredToolSummary: toolRegistry.getDeferredToolSummary(),
        sessionMessageCount: 0,
        sessionId: "channel",
      }),
  });
  channelGateway.register(feishuChannel);
  console.log('  启动 Channel...');
  await channelGateway.startAll();

  // Debug: 显示 Prompt Pipe 各模块状态
  builder.debug(makePromptCtx());

  // 斜杠命令分发器：命中即本地处理，不进对话历史、不调用模型。
  // 新增命令只需往 commands/ 下加 handler 并在此登记。

  const dispatchCommand = createDispatcher([
    ...contextCommands,
    ...memoryCommands,
    ...createSkillCommands(skillLoader, activeSkills),
    ...createPluginCommands(pluginManager, availablePlugins)
  ]);

  while (true) {
    let q: string;
    try {
      q = await rl.question("You：");
    } catch {
      // stdin 关闭（EOF / Ctrl+D / 管道结束）时 question 会 reject，正常退出
      break;
    }

    const trimedQuery = q.trim();
    if (!trimedQuery || trimedQuery === "exit") {
      rl.close();
      await toolRegistry.closeAllMCP();
      await pluginManager.unloadAll()
      await channelGateway.stopAll()
      break;
    }

    const SYSTEM = builder.build(makePromptCtx());


    // 斜杠命令：交给命令分发器，命中即本地处理，continue 下一轮
    if (trimedQuery.startsWith("/")) {
      const commandCtx: CommandContext = {
        messages,
        toolRegistry,
        usageTracker,
        model: {
          name: MODEL_NAME,
          id: MODEL_ID,
          windowTokens: MODEL_WINDOW_TOKENS,
        },
        systemPrompt: SYSTEM,
        rebuildSystemPrompt: () => builder.build(makePromptCtx()),
        memoryStore,
        sessionStore,
        budget,
        msgTimestamps,
        llm: model,
      };

      if (await dispatchCommand(trimedQuery, commandCtx)) continue;
      console.log(`未知命令：${trimedQuery}`);
      continue;
    }

    const userMsg: ModelMessage = {
      role: "user",
      content: trimedQuery,
    };

    messages.push(userMsg);
    msgTimestamps.set(messages.length - 1, Date.now());
    sessionStore.append(userMsg);

    const beforeLen = messages.length;
    const turnStart = usageTracker.stepCount;
    await agentLoop(
      model,
      toolRegistry,
      messages,
      SYSTEM,
      budget,
      msgTimestamps,
      usageTracker,
    );

    console.log(`  [用量·本轮] ${formatUsage(usageTracker.totals(turnStart))}`);

    // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
    const newMessages = messages.slice(beforeLen);
    sessionStore.appendAll(newMessages);
  }

  console.log(`\n[用量·累计] ${formatUsage(usageTracker.totals())}`);
  console.log("Bye!");
  rl.close();
}

console.log('Super Agent — Fuses (type "exit" to quit)');
console.log("快捷命令：");
console.log("  /context    — 终端里看 context 占用矩阵（参考 Claude Code）");
console.log("  /usage      — 累计 token 用量、cache 命中率、节省金额");
if (loadedSkills.length > 0) {
  console.log(`  发现 ${loadedSkills.length} 个 skill：`);
  for (const s of loadedSkills) console.log(`    /${s.name} — ${s.description}`);
  console.log('');
}
await main();
