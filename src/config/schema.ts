import { z } from 'zod';
import {
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  MODEL_PROVIDERS,
} from './presets.js';

/**
 * Zod 4 里对象字段的 `.default({})` 不会套用内部字段的默认值（会把 {} 原样返回），
 * 必须用 `.prefault({})`：先补输入、再走内部默认值。下面统一用 prefault。
 */

export const ModelConfigSchema = z.object({
  /** 供应商预设，仅用于选 Key 环境变量、决定文档提示；请求统一走 OpenAI 兼容协议 */
  provider: z.enum(MODEL_PROVIDERS).default(DEFAULT_PROVIDER),
  /** 传给接口的模型 id，如 deepseek-flash / qwen-plus / gpt-4.1 */
  name: z.string().min(1).default(DEFAULT_MODEL),
  baseURL: z.string().min(1).default(DEFAULT_BASE_URL),
  /** 可直接写 Key，也支持 ${ENV_VAR}；留空则从 provider 约定的环境变量里找 */
  apiKey: z.string().default(''),
  /** 触发上下文压缩使用的窗口大小（tokens）；按所选模型真实窗口填 */
  contextWindow: z.number().int().positive().default(DEFAULT_CONTEXT_WINDOW),
  /** DeepSeek 的 thinking 模式与 @ai-sdk/openai 不兼容，默认关闭；换非 DeepSeek 模型可关掉此兼容层 */
  disableReasoning: z.boolean().default(true),
  /** 单次运行累计 token 预算上限，超出后 agent loop 强制停止 */
  budgetLimit: z.number().int().positive().default(1_000_000),
});

export const PluginConfigSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /** 插件自定义配置，支持 ${ENV_VAR} 展开 */
  config: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .prefault({}),
});

export const FeishuChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
});

export const ChannelConfigSchema = z.object({
  feishu: FeishuChannelConfigSchema.prefault({}),
});

export const AgentConfigSchema = z.object({
  maxSpawnDepth: z.number().int().min(0).max(5).default(1),
  /** 同时运行的子 Agent 上限 */
  maxConcurrency: z.number().int().min(1).max(10).default(3),
  defaultTimeout: z.number().int().positive().default(60_000),
});

export const SecurityConfigSchema = z.object({
  /** 可选值见 security/roles.ts */
  defaultRole: z.enum(['owner', 'collaborator', 'guest']).default('owner'),
  /** 写文件前打印审计日志 */
  auditLog: z.boolean().default(true),
  /** 给 bash 输出加时间戳 */
  bashTimestamp: z.boolean().default(true),
});

export const MemoryConfigSchema = z.object({
  /** .memory/ 所在目录 */
  dataDir: z.string().default('.'),
});

export const RagConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** 向量库文件 */
  dbPath: z.string().default('knowledge.db'),
  /** 向量化（DashScope embedding）用的 Key；留空则从 RAG/QWEN/DASHSCOPE 环境变量里找 */
  apiKey: z.string().default(''),
});

export const CronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** .cron/ 所在目录 */
  dataDir: z.string().default('.'),
});

export const SessionConfigSchema = z.object({
  /** .sessions/<id>.jsonl；默认沿用历史会话 default1，避免 --continue 找不到旧记录 */
  id: z.string().min(1).default('default1'),
});

export const UsageConfigSchema = z.object({
  trackingFile: z.string().default('.usage/today.jsonl'),
});

export const SuperAgentConfigSchema = z
  .object({
    version: z.string().default('1.0'),
    model: ModelConfigSchema.prefault({}),
    plugins: z.array(PluginConfigSchema).default([]),
    channels: ChannelConfigSchema.prefault({}),
    agents: AgentConfigSchema.prefault({}),
    security: SecurityConfigSchema.prefault({}),
    memory: MemoryConfigSchema.prefault({}),
    rag: RagConfigSchema.prefault({}),
    cron: CronConfigSchema.prefault({}),
    session: SessionConfigSchema.prefault({}),
    usage: UsageConfigSchema.prefault({}),
  })
  .prefault({});

export type SuperAgentConfig = z.infer<typeof SuperAgentConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type PluginConfigEntry = z.infer<typeof PluginConfigSchema>;
