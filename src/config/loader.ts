import fs from 'node:fs';
import { SuperAgentConfigSchema, type SuperAgentConfig } from './schema.js';
import {
  DEFAULT_PROVIDER,
  MODEL_PRESETS,
} from './presets.js';

export const CONFIG_FILE = process.env.SUPER_AGENT_CONFIG || 'super-agent.config.json';

const ENV_VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** 把 `${VAR}` 展开成环境变量值；未设置时保留字面量，交由使用方判断是否「未配置」。 */
function substituteEnvVars(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(ENV_VAR_RE, (match, name: string) => process.env[name] ?? match);
  }
  if (Array.isArray(value)) return value.map(substituteEnvVars);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, substituteEnvVars(item)]),
    );
  }
  return value;
}

/**
 * config 只写了 provider 时，用预设补齐 baseURL / name / contextWindow，
 * 这样「切供应商」只需要改一个字段。用户显式填写的值优先于预设。
 */
function withModelPreset(raw: Record<string, unknown>): Record<string, unknown> {
  const model = raw.model;
  // 结构不对就原样返回，交给 schema 报错，避免把非法配置"修补"成合法值
  if (model && (typeof model !== 'object' || Array.isArray(model))) return raw;

  const modelConfig = model as Record<string, unknown> | undefined;
  const provider = modelConfig?.provider ?? DEFAULT_PROVIDER;

  if (provider === 'custom') {
    if (!modelConfig?.baseURL) {
      throw new Error('provider 为 custom 时必须显式填写 model.baseURL');
    }
    return raw;
  }

  const preset = MODEL_PRESETS[provider as keyof typeof MODEL_PRESETS];
  // 未知 provider 不套预设，交给 schema 报枚举错误
  if (!preset) return raw;

  return {
    ...raw,
    model: {
      baseURL: preset.baseURL,
      name: preset.defaultModel,
      contextWindow: preset.contextWindow,
      ...modelConfig,
    },
  };
}

export function loadConfig(path = CONFIG_FILE): SuperAgentConfig {
  if (!fs.existsSync(path)) {
    console.log(`  未找到 ${path}，使用默认配置（${DEFAULT_PROVIDER} / 环境变量取 Key）`);
    console.log('  生成配置文件：pnpm run config:init\n');
    return SuperAgentConfigSchema.parse({});
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`解析 ${path} 失败: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${path} 的内容必须是 JSON 对象`);
  }

  const result = SuperAgentConfigSchema.safeParse(substituteEnvVars(withModelPreset(raw)));
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `    ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`配置文件 ${path} 校验失败:\n${issues}`);
  }

  console.log(`  ✓ 已加载 ${path}`);
  return result.data;
}
