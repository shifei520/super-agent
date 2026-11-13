/**
 * 模型供应商预设。
 *
 * 本系统所有对话模型都走 OpenAI 兼容协议，所以「切换供应商」本质只是换
 * baseURL + apiKey + model id 三件套。这里把常用的三套固化下来，
 * config 只写了 provider、没写 baseURL/name 时由 loader 用预设补齐。
 *
 * 注意：presets 被 schema.ts 反向依赖（z.enum 用 MODEL_PROVIDERS），
 * 因此本文件不能 import schema，避免循环依赖。
 */
export const MODEL_PROVIDERS = [
  'deepseek',
  'dashscope',
  'openai',
  'custom',
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface ModelPreset {
  label: string;
  baseURL: string;
  /** 该供应商约定的 API Key 环境变量，第一个为写入 .env 时使用的名字 */
  envKeys: string[];
  defaultModel: string;
  contextWindow: number;
  models: Array<{ id: string; note: string; contextWindow: number }>;
}

export const MODEL_PRESETS: Record<Exclude<ModelProvider, 'custom'>, ModelPreset> = {
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    // 历史配置里 Key 存在 DASHSCOPE_API_KEY 下（实际是 DeepSeek Key），
    // 保留为兜底来源，避免升级后启动失败。
    envKeys: ['DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY'],
    defaultModel: 'deepseek-flash',
    contextWindow: 1_000_000,
    models: [
      { id: 'deepseek-flash', note: '快速、便宜（推荐）', contextWindow: 1_000_000 },
      { id: 'deepseek-v4-pro', note: '能力更强，价格更高', contextWindow: 1_000_000 },
    ],
  },
  dashscope: {
    label: '阿里云百炼 / 通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKeys: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
    defaultModel: 'qwen-plus',
    contextWindow: 1_000_000,
    models: [
      { id: 'qwen-plus', note: '均衡（推荐）', contextWindow: 1_000_000 },
      { id: 'qwen-flash', note: '快速、便宜', contextWindow: 1_000_000 },
      { id: 'qwen3-max', note: '能力最强，价格最高', contextWindow: 262_144 },
    ],
  },
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    envKeys: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-4.1',
    contextWindow: 1_000_000,
    models: [
      { id: 'gpt-4.1', note: '通用', contextWindow: 1_000_000 },
      { id: 'gpt-4o-mini', note: '快速、便宜', contextWindow: 128_000 },
    ],
  },
};

export const DEFAULT_PROVIDER: ModelProvider = 'deepseek';
export const DEFAULT_MODEL = MODEL_PRESETS.deepseek.defaultModel;
export const DEFAULT_BASE_URL = MODEL_PRESETS.deepseek.baseURL;
export const DEFAULT_CONTEXT_WINDOW = MODEL_PRESETS.deepseek.contextWindow;

/** provider 对应的 Key 环境变量候选；custom 没有约定，交给 runtime 兜底 */
export function getProviderEnvKeys(provider: ModelProvider): string[] {
  if (provider === 'custom') return ['CUSTOM_API_KEY', 'OPENAI_API_KEY'];
  return MODEL_PRESETS[provider].envKeys;
}
