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
import { setModelRuntime } from "./context/config";
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
import { HookPipeline } from "./security/hooks";
import { createSecurityCommands } from "./commands/security";
import { CronService } from "./cron/service";
import { createCronTool } from "./tools/cron-tools";
import { createCronCommands } from "./commands/cron";
import { SubAgentRegistry } from "./subagents/registry";
import { createSpawnTool } from "./tools/spawn-tools";
import { SpawnContext } from "./subagents/spawn";
import { createAgentCommands } from "./commands/subagents";
import { CONFIG_FILE, loadConfig } from "./config/loader";
import type { ModelConfig } from "./config/schema";
import { getProviderEnvKeys } from "./config/presets";

const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * 解析配置里的密钥：字面量直接用；`${VAR}` 或留空时按约定环境变量兜底。
 * loader 已把能展开的 `${VAR}` 换成了真实值，所以这里剩下 `${VAR}` 就说明变量未设置。
 */
function resolveSecret(
  value: string,
  envKeys: string[],
): { value: string; source: string } {
  if (value && !ENV_REF_RE.test(value)) return { value, source: "配置文件" };

  for (const key of envKeys) {
    const resolved = process.env[key];
    if (resolved) return { value: resolved, source: key };
  }
  return { value: "", source: "" };
}

function createChatModel(config: ModelConfig) {
  const envKeys = getProviderEnvKeys(config.provider);
  const { value: apiKey, source } = resolveSecret(config.apiKey, envKeys);

  if (!apiKey) {
    throw new Error(
      `未配置模型 API Key（provider=${config.provider}）：` +
        `请设置环境变量 ${envKeys.join(" / ")}，或在 ${CONFIG_FILE} 中填写 model.apiKey`,
    );
  }

  // 所有供应商都走 OpenAI 兼容协议，切模型只需换 baseURL / key / name
  const client = createOpenAI({ baseURL: config.baseURL, apiKey });
  console.log(
    `  模型: ${config.provider} / ${config.name} @ ${config.baseURL}（Key 来自 ${source}）`,
  );
  return client.chat(config.name);
}

export async function startAgent(argv: string[] = process.argv.slice(2)) {
  console.log('Super Agent — Fuses (type "exit" to quit)');

  // ── 配置 ────────────────────────────────
  const config = loadConfig();
  setModelRuntime({
    contextWindow: config.model.contextWindow,
    disableReasoning: config.model.disableReasoning,
  });

  const model = createChatModel(config.model);

  // 用量控制：单次运行累计 token 预算
  const budget: BudgetState = {
    used: 0,
    limit: config.model.budgetLimit,
  };

  // ── SKILL ────────────────────────────────
  const skillLoader = new SkillLoader(".");
  const loadedSkills = skillLoader.load();
  const activeSkills = new Set<string>();
  if (loadedSkills.length > 0) {
    console.log(`  发现 ${loadedSkills.length} 个 skill：`);
    for (const s of loadedSkills) {
      console.log(`    /${s.name} — ${s.description}`);
    }
  }
  console.log("快捷命令：");
  console.log("  /context    — 终端里看 context 占用矩阵（参考 Claude Code）");
  console.log("  /usage      — 累计 token 用量、cache 命中率、节省金额");
  console.log("  /plugin     — 插件列表 / load / unload");
  console.log("  /cron       — 定时任务列表 / 日志");
  console.log("  /subagents  — 子 Agent 执行记录");
  console.log("  /role       — 查看或切换安全角色");
  console.log("  /hooks      — 查看已注册的 Hook\n");
  // ── Registry ────────────────────────────────
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(...allTools);
  toolRegistry.register(createToolSearchTool(toolRegistry));
  toolRegistry.register(createSkillTool(skillLoader, activeSkills));
  // ── Memory ────────────────────────────────
  const memoryStore = new MemoryStore(config.memory.dataDir);
  toolRegistry.register(createMemoryTool(memoryStore));

  // ── RAG ────────────────────────────────
  // 没有向量化 Key 时整块跳过，避免注册了 rag_search 却在调用时报 401
  let vectorStore: SqliteVectorStore | undefined;
  if (!config.rag.enabled) {
    console.log("  RAG: 已在配置中禁用");
  } else {
    const ragKey = resolveSecret(config.rag.apiKey, [
      "RAG_API_KEY",
      "QWEN_API_KEY",
      "DASHSCOPE_API_KEY",
    ]);
    if (!ragKey.value) {
      console.log(
        "  RAG: 未找到向量化 API Key（RAG_API_KEY / QWEN_API_KEY / DASHSCOPE_API_KEY），已跳过知识库",
      );
    } else {
      vectorStore = new SqliteVectorStore(config.rag.dbPath);
      toolRegistry.register(
        ...createRagTools(vectorStore, createDashScopeEmbedder(ragKey.value)),
      );
      console.log(`  RAG: ${config.rag.dbPath}（向量化 Key 来自 ${ragKey.source}）`);
    }
  }

  // ── Plugins ────────────────────────────────
  const pluginManager = new PluginManager(toolRegistry);
  const availablePlugins = new Map<string, PluginDefinition>([
    ["supabase", supabasePlugin],
  ]);

  // ── Security: Hook Pipeline ────────────────────────────────
  const hookPipeline = new HookPipeline();
  toolRegistry.setHookPipeline(hookPipeline);
  toolRegistry.setRole(config.security.defaultRole);

  if (config.security.auditLog) {
    // 写文件前记录审计日志
    hookPipeline.registerPre("audit-log", (toolName, input) => {
      if (toolName === "write_file" || toolName === "edit_file") {
        const path = (input as any)?.path || "unknown";
        console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`);
      }
      return { action: "allow" };
    });
  }
  if (config.security.bashTimestamp) {
    // 给 bash 输出加时间戳
    hookPipeline.registerPost("bash-timestamp", (toolName, _input, output) => {
      if (toolName === "bash") {
        const timestamp = new Date().toISOString();
        return {
          action: "modify",
          modifiedOutput: `[${timestamp}]\n${output}`,
        };
      }
      return { action: "allow" };
    });
  }

  // ── Cron Service ────────────────────────────────
  const cronService = config.cron.enabled
    ? new CronService(config.cron.dataDir)
    : null;
  if (cronService) toolRegistry.register(createCronTool(cronService));

  // ── Sub-Agent ────────────────────────────────
  const subAgentRegistry = new SubAgentRegistry({
    maxSpawnDepth: config.agents.maxSpawnDepth,
    maxConcurrency: config.agents.maxConcurrency,
    defaultTimeout: config.agents.defaultTimeout,
  });

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
        await toolRegistry.registerMCPServer("github", client);
      } catch (err) {
        console.log(
          `  MCP 连接失败: ${err instanceof Error ? err.message : err}`,
        );
        console.log("  降级为 Mock MCP...");
      }
    }
  }

  const usageTracker = new UsageTracker(config.usage.trackingFile);
  await connectMCP();

  // 启动时按配置加载插件：未启用/未在配置中出现的插件不动
  console.log("  加载插件...");
  for (const entry of config.plugins) {
    const definition = availablePlugins.get(entry.name);
    if (!entry.enabled) {
      console.log(`  - ${entry.name} — 未启用`);
    } else if (!definition) {
      console.log(`  ✗ ${entry.name} — 未知插件，请检查配置中的名字`);
    } else {
      try {
        const tools = await pluginManager.load(definition, entry.config);
        console.log(`  ✓ ${entry.name} — ${tools.length} 个工具`);
      } catch (err) {
        const message = err instanceof Error ? err.message : err;
        console.log(`  ✗ ${entry.name} — 加载失败: ${message}`);
      }
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
  const isContinue = argv.includes("--continue") || argv.includes("-c");
  const sessionId = config.session.id;
  const sessionStore = new SessionStore(sessionId);

  let messages: ModelMessage[] = [];
  // 消息索引 → 创建毫秒时间戳（供 applyDefense 的 TTL 清理用）。
  // 恢复的历史消息没有可靠时间戳，不记录即视为未知、永不被 TTL 清理。
  const msgTimestamps = new Map<number, number>();
  if (isContinue && sessionStore.exists()) {
    messages = sessionStore.load();
    console.log(`[Session] 恢复会话 ${sessionId}，${messages.length} 条历史消息`);
  } else {
    console.log(`[Session] 新会话 ${sessionId}`);
  }

  // Prompt Pipe 组装 system prompt
  const builder = new PromptBuilder()
    .pipe("coreRules", coreRules())
    .pipe("toolGuide", toolGuide())
    .pipe("deferredTools", deferredTools())
    .pipe("memoryContext", () => memoryStore.buildPromptSection());
  if (vectorStore) {
    builder.pipe("ragContext", ragContext(vectorStore));
  }
  builder
    .pipe("skillContext", () => skillLoader.buildPromptSection(activeSkills))
    .pipe("sessionContext", sessionContext());

  function makePromptCtx(): PromptContext {
    return {
      toolCount: toolRegistry.getActiveTools().length,
      deferredToolSummary: toolRegistry.getDeferredToolSummary(),
      sessionMessageCount: messages.length,
      sessionId,
    };
  }

  function getSpawnCtx(): SpawnContext {
    return {
      model,
      toolRegistry,
      agentRegistry: subAgentRegistry,
      buildSystem: () => builder.build(makePromptCtx()),
      currentDepth: 0,
    };
  }
  toolRegistry.register(createSpawnTool(getSpawnCtx));

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

  const feishu = config.channels.feishu;
  if (feishu.enabled) {
    const appId = resolveSecret(feishu.appId, ["FEISHU_APP_ID"]);
    const appSecret = resolveSecret(feishu.appSecret, ["FEISHU_APP_SECRET"]);
    if (appId.value && appSecret.value) {
      channelGateway.register(
        new FeiShuChannel({
          appId: appId.value,
          appSecret: appSecret.value,
        }),
      );
    } else {
      console.log(
        "  ✗ 飞书 Channel 已启用，但 appId/appSecret 未配置，已跳过",
      );
    }
  }

  console.log("  启动 Channel...");
  await channelGateway.startAll();

  if (cronService) {
    cronService.load();
    cronService.setExecutor({
      runAgentPrompt: async (prompt) => {
        const cronMessages: ModelMessage[] = [{ role: "user", content: prompt }];
        const system = builder.build(makePromptCtx());
        await agentLoop(model, toolRegistry, cronMessages, system, budget);

        const last = cronMessages.at(-1);
        if (!last) return "(无输出)";
        if (typeof last.content === "string") return last.content;
        const text = last.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        return text || "(无输出)";
      },
      notify: (message) => {
        console.log(`\n${message}`);
      },
    });
    cronService.start();
    const cronJobs = cronService.list();
    console.log(`  Cron: ${cronJobs.length} 个任务已加载`);
  } else {
    console.log("  Cron: 已在配置中禁用");
  }

  // Debug: 显示 Prompt Pipe 各模块状态
  builder.debug(makePromptCtx());

  // 斜杠命令分发器：命中即本地处理，不进对话历史、不调用模型。
  // 新增命令只需往 commands/ 下加 handler 并在此登记。

  const dispatchCommand = createDispatcher([
    ...contextCommands,
    ...memoryCommands,
    ...createSkillCommands(skillLoader, activeSkills),
    ...createPluginCommands(pluginManager, availablePlugins, config.plugins),
    ...createSecurityCommands(toolRegistry, hookPipeline),
    ...(cronService ? createCronCommands(cronService) : []),
    ...createAgentCommands(subAgentRegistry),
  ]);

  // /context 展示用的模型元信息
  const modelInfo = {
    name: config.model.name,
    id: config.model.name,
    windowTokens: config.model.contextWindow,
  };

  while (true) {
    let q: string;
    try {
      q = await rl.question("You：");
    } catch {
      // stdin 关闭（EOF / Ctrl+D / 管道结束）时 question 会 reject，正常退出
      break;
    }

    const query = q.trim();
    if (!query || query === "exit") {
      rl.close();
      cronService?.stop();
      await toolRegistry.closeAllMCP();
      await pluginManager.unloadAll();
      await channelGateway.stopAll();
      break;
    }

    const SYSTEM = builder.build(makePromptCtx());

    // 斜杠命令：交给命令分发器，命中即本地处理，continue 下一轮
    if (query.startsWith("/")) {
      const commandCtx: CommandContext = {
        messages,
        toolRegistry,
        usageTracker,
        model: modelInfo,
        systemPrompt: SYSTEM,
        rebuildSystemPrompt: () => builder.build(makePromptCtx()),
        memoryStore,
        sessionStore,
        budget,
        msgTimestamps,
        llm: model,
      };

      if (await dispatchCommand(query, commandCtx)) continue;
      console.log(`未知命令：${query}`);
      continue;
    }

    const userMsg: ModelMessage = {
      role: "user",
      content: query,
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
