import 'dotenv/config';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import { CONFIG_FILE } from './loader.js';
import { SuperAgentConfigSchema, type SuperAgentConfig } from './schema.js';
import {
  MODEL_PRESETS,
  MODEL_PROVIDERS,
  getProviderEnvKeys,
  type ModelProvider,
} from './presets.js';

const ENV_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const ROLES = ['owner', 'collaborator', 'guest'] as const;

type Ask = (question: string) => Promise<string>;

function readEnvFile(): Map<string, string> {
  if (!fs.existsSync('.env')) return new Map();
  const map = new Map<string, string>();
  for (const line of fs.readFileSync('.env', 'utf-8').split(/\r?\n/)) {
    const match = line.match(ENV_LINE_RE);
    if (match) map.set(match[1], match[2]);
  }
  return map;
}

/** 合并而不是覆盖 .env：保留用户已有变量与注释行。 */
function mergeEnvFile(updates: Record<string, string>) {
  const lines = fs.existsSync('.env')
    ? fs.readFileSync('.env', 'utf-8').split(/\r?\n/)
    : [];
  const pending = new Map(Object.entries(updates));

  const rewritten = lines.map((line) => {
    const match = line.match(ENV_LINE_RE);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1])!;
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });

  for (const [key, value] of pending) rewritten.push(`${key}=${value}`);

  const output = rewritten.join('\n').replace(/\n+$/, '') + '\n';
  fs.writeFileSync('.env', output, 'utf-8');
}

/** 读取已有配置作为向导默认值；无法解析时按空配置处理。 */
function readPrevConfig(): SuperAgentConfig | undefined {
  if (!fs.existsSync(CONFIG_FILE)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return SuperAgentConfigSchema.parse(raw);
  } catch {
    console.log(`  现有 ${CONFIG_FILE} 无法解析，将按默认值重新生成`);
    return undefined;
  }
}

async function askYesNo(ask: Ask, question: string, fallback: boolean): Promise<boolean> {
  const answer = (await ask(`${question} (${fallback ? 'Y/n' : 'y/N'}): `)).toLowerCase();
  if (!answer) return fallback;
  return answer === 'y' || answer === 'yes';
}

async function askNumber(ask: Ask, question: string, fallback: number): Promise<number> {
  return parseInt(await ask(question), 10) || fallback;
}

export async function runInit() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask: Ask = (question) =>
    new Promise((resolve) => {
      console.log(question);
      rl.question('  > ', (answer) => resolve(answer.trim()));
    });

  try {
    console.log('\n  Super Agent 初始化向导\n');

    const configExists = fs.existsSync(CONFIG_FILE);
    const prev = configExists ? readPrevConfig() : undefined;
    if (configExists && !(await askYesNo(ask, `  ${CONFIG_FILE} 已存在，覆盖?`, false))) {
      console.log('  已取消\n');
      return;
    }

    const envFile = readEnvFile();

    // ── 供应商 ────────────────────────────────
    const presetProviders = MODEL_PROVIDERS.filter((p) => p !== 'custom');
    const providers: ModelProvider[] = [...presetProviders, 'custom'];
    console.log('\n  选择模型供应商:\n');
    presetProviders.forEach((p, i) => {
      console.log(`    ${i + 1}. ${MODEL_PRESETS[p].label} (${p})`);
    });
    console.log(`    ${providers.length}. 自定义 OpenAI 兼容接口\n`);

    const providerDefault = Math.max(
      1,
      providers.indexOf(prev?.model.provider ?? 'deepseek') + 1,
    );
    const providerIndex = await askNumber(ask, `  供应商 [${providerDefault}]: `, providerDefault);
    const provider = providers[providerIndex - 1] ?? 'custom';
    const preset = provider === 'custom' ? undefined : MODEL_PRESETS[provider];

    // ── 模型 ────────────────────────────────
    let modelName: string;
    let baseURL: string;
    let contextWindow: number;

    if (preset) {
      console.log(`\n  选择模型（${preset.label}）:\n`);
      preset.models.forEach((m, i) => {
        console.log(`    ${i + 1}. ${m.id.padEnd(20)} ${m.note}`);
      });
      console.log(`    ${preset.models.length + 1}. 手动输入模型 id\n`);

      const modelDefault = Math.max(
        1,
        preset.models.findIndex((m) => m.id === prev?.model.name) + 1,
      );
      const modelIndex = await askNumber(ask, `  模型 [${modelDefault}]: `, modelDefault);
      const chosen = preset.models[modelIndex - 1];

      if (chosen) {
        modelName = chosen.id;
        contextWindow = chosen.contextWindow;
      } else {
        modelName = (await ask(`  模型 id [${preset.defaultModel}]: `)) || preset.defaultModel;
        contextWindow = await askNumber(
          ask,
          `  上下文窗口 tokens [${preset.contextWindow}]: `,
          preset.contextWindow,
        );
      }
      baseURL = preset.baseURL;
    } else {
      modelName = (await ask('  模型 id（如 llama-3.3-70b）: ')) || prev?.model.name || '';
      baseURL = (await ask('  baseURL（OpenAI 兼容地址，含 /v1）: ')) || prev?.model.baseURL || '';
      contextWindow = await askNumber(ask, '  上下文窗口 tokens [128000]: ', 128_000);
    }

    // ── API Key ────────────────────────────────
    const envKeys = getProviderEnvKeys(provider);
    const primaryEnvKey = envKeys[0];
    const keyInput = await ask(
      `\n  ${preset?.label ?? '自定义'} API Key（留空则读取环境变量 ${envKeys.join(' / ')}）: `,
    );

    const envUpdates: Record<string, string> = {};
    let apiKeyRef = '';
    if (keyInput) {
      envUpdates[primaryEnvKey] = keyInput;
      apiKeyRef = `\${${primaryEnvKey}}`;
    } else if (prev?.model.provider === provider && prev.model.apiKey) {
      // 同供应商才沿用旧 Key，避免拿 DeepSeek Key 打 DashScope
      apiKeyRef = prev.model.apiKey;
    } else if (envFile.has(primaryEnvKey)) {
      apiKeyRef = `\${${primaryEnvKey}}`;
    }

    // ── 飞书 Channel ────────────────────────────────
    const enableFeishu = await askYesNo(
      ask,
      '\n  启用飞书 Channel?',
      prev?.channels.feishu.enabled ?? false,
    );

    let feishuAppId = prev?.channels.feishu.appId ?? '';
    let feishuAppSecret = prev?.channels.feishu.appSecret ?? '';
    if (enableFeishu) {
      const appId = await ask(
        `  飞书 App ID${envFile.has('FEISHU_APP_ID') ? '（留空沿用现有环境变量）' : ''}: `,
      );
      if (appId) {
        envUpdates.FEISHU_APP_ID = appId;
        feishuAppId = '${FEISHU_APP_ID}';
      }

      const appSecret = await ask(
        `  飞书 App Secret${envFile.has('FEISHU_APP_SECRET') ? '（留空沿用现有环境变量）' : ''}: `,
      );
      if (appSecret) {
        envUpdates.FEISHU_APP_SECRET = appSecret;
        feishuAppSecret = '${FEISHU_APP_SECRET}';
      }
    }

    // ── RAG ────────────────────────────────
    const enableRag = await askYesNo(ask, '\n  启用 RAG 知识库?', prev?.rag.enabled ?? true);

    // ── 子 Agent 并发 ────────────────────────────────
    const concurrencyDefault = prev?.agents.maxConcurrency ?? 3;
    const maxConcurrency = await askNumber(
      ask,
      `\n  子 Agent 最大并发数 [${concurrencyDefault}]: `,
      concurrencyDefault,
    );

    // ── 安全角色 ────────────────────────────────
    console.log('\n  默认安全角色:\n');
    console.log('    1. owner         全部工具（推荐）');
    console.log('    2. collaborator  禁用 bash');
    console.log('    3. guest         只读工具\n');

    const roleDefault = Math.max(1, ROLES.indexOf(prev?.security.defaultRole ?? 'owner') + 1);
    const roleIndex = await askNumber(ask, `  角色 [${roleDefault}]: `, roleDefault);
    const defaultRole = ROLES[roleIndex - 1] ?? 'owner';

    // ── supabase 插件 ────────────────────────────────
    const prevSupabase = prev?.plugins.find((p) => p.name === 'supabase');
    const enableSupabase = await askYesNo(
      ask,
      '\n  启用 supabase 插件?',
      prevSupabase?.enabled ?? false,
    );

    // schema 解析会补齐缺省字段并自检，避免生成一份启动就报错的配置
    const config = SuperAgentConfigSchema.parse({
      version: prev?.version ?? '1.0',
      model: {
        ...prev?.model,
        provider,
        name: modelName,
        baseURL,
        apiKey: apiKeyRef,
        contextWindow,
        // DeepSeek 的 thinking 模式与 @ai-sdk/openai 不兼容，必须关掉
        disableReasoning: provider === 'deepseek',
      },
      plugins: [
        {
          name: 'supabase',
          enabled: enableSupabase,
          config: prevSupabase?.config ?? {
            supabaseUrl: '${SUPABASE_URL}',
            supabaseKey: '${SUPABASE_KEY}',
          },
        },
      ],
      channels: {
        ...prev?.channels,
        feishu: { enabled: enableFeishu, appId: feishuAppId, appSecret: feishuAppSecret },
      },
      agents: { ...prev?.agents, maxConcurrency },
      security: { ...prev?.security, defaultRole },
      memory: prev?.memory ?? {},
      rag: { ...prev?.rag, enabled: enableRag },
      cron: prev?.cron ?? {},
      session: prev?.session ?? {},
      usage: prev?.usage ?? {},
    });

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    console.log(`\n  ✓ ${CONFIG_FILE} 已生成`);

    if (Object.keys(envUpdates).length > 0) {
      mergeEnvFile(envUpdates);
      console.log('  ✓ .env 已更新（仅合并本次输入的密钥）');
    }

    console.log(`  模型: ${config.model.provider} / ${config.model.name} @ ${config.model.baseURL}`);
    console.log(`  上下文窗口: ${config.model.contextWindow.toLocaleString()} tokens`);
    console.log(
      `  RAG: ${config.rag.enabled ? '启用' : '禁用'} · Cron: ${config.cron.enabled ? '启用' : '禁用'}`,
    );
    console.log('\n  启动 Agent: pnpm start\n');
  } finally {
    rl.close();
  }
}
