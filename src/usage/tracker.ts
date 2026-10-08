import type { LanguageModelUsage } from "ai";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 计价货币。官方价目页用什么币种，表里就用什么币种 —— 不做汇率换算，避免自己造数。 */
export type Currency = "USD" | "CNY";

export const CURRENCY_SYMBOL: Record<Currency, string> = {
  USD: "$",
  CNY: "¥",
};

/** 单一档位的单价，单位：currency / 1M tokens */
export interface Price {
  /** 输入，缓存未命中 */
  input: number;
  /** 输入，缓存命中（官方叫"缓存命中"或 cached input） */
  cacheRead: number;
  /** 输出。DeepSeek 的 reasoning token 计入 completion_tokens，已含在内 */
  output: number;
  /**
   * 输入，写入/创建缓存。
   * 省略 = 官方价目页没有这项（不单收写入费，或其缓存是平台隐式维护的）。
   */
  cacheWrite?: number;
}

export interface ModelPricing {
  currency: Currency;
  /** 标准时段单价。只有 DeepSeek 这类分时段定价的模型，它等于官方的「空闲时段」价 */
  standard: Price;
  /** 高峰时段单价。目前只有 DeepSeek 需要 */
  peak?: Price;
}

export interface ResolvedPricing extends Price {
  currency: Currency;
  /** peak = 高峰价；offPeak = 分时段定价模型的空闲价；flat = 不分时段 */
  tier: "peak" | "offPeak" | "flat";
}

/**
 * 单价表。**数字照抄各家官方价目页，不换算汇率、不推测**。
 * 抓取日期 2026-10-07。价格会变，改动前请回官网核对。
 *
 * 单位一律「每 1M tokens」，币种随官方页面：国内厂商是元，海外是美元。
 * 不同币种不会混加成同一个数（UsageTracker 按币种分开累计）。
 *
 * 关于缓存写入（cacheWrite）：
 *   官方把「缓存写入/创建」单列成计费项时才填。DeepSeek 只有命中/未命中/输出三行，
 *   没有写入费，所以不填；Kimi K3、Anthropic、百炼显式缓存有，就填上。
 */
export const PRICE_TABLE: Record<string, ModelPricing | undefined> = {
  // ── DeepSeek 原厂（人民币，分时段定价）────────────────────────────
  // 来源 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
  // 空闲价 = 高峰价的一半；高峰时段为北京时间周一至周五 09:00-12:00、14:00-18:00。
  // 英文页同一张表用美元标价（$0.15 / $0.30 / $0.60 …），与人民币表按约 6.7~6.8
  // 换算一一对应（两页各自四舍五入，flash 与 pro 的隐含汇率略有差异）——
  // 两页数字不矛盾，只是币种不同。
  "deepseek-flash": {
    currency: "CNY",
    standard: { input: 1, cacheRead: 0.02, output: 4 },
    peak: { input: 2, cacheRead: 0.04, output: 8 },
  },
  "deepseek-v4-pro": {
    currency: "CNY",
    standard: { input: 4.5, cacheRead: 0.15, output: 13.5 },
    peak: { input: 9, cacheRead: 0.3, output: 27 },
  },

  // ── Moonshot / Kimi（人民币）─────────────────────────────────────
  // 来源 https://platform.moonshot.cn/docs/pricing/chat
  // K3 的缓存写入分两档 TTL：5min 20 元、1h 40 元，这里取默认的 5min 档。
  "kimi-k3": {
    currency: "CNY",
    standard: { input: 20, cacheRead: 2, output: 100, cacheWrite: 20 },
  },
  "kimi-k2.6": {
    currency: "CNY",
    standard: { input: 6.5, cacheRead: 1.1, output: 27 },
  },
  "kimi-k2.7-code": {
    currency: "CNY",
    standard: { input: 6.5, cacheRead: 1.3, output: 27 },
  },

  // ── 智谱 GLM（人民币）────────────────────────────────────────────
  // 来源 https://docs.bigmodel.cn/cn/guide/start/pricing
  // 缓存存储（元/百万 tokens/小时）目前限时免费，故不填；官方无独立缓存写入价。
  // GLM-5 输入 ≥32K 是 6 / 1.5 / 22；GLM-4.7 输入 ≥32K 档更高，这里取基础档。
  "glm-5.3": {
    currency: "CNY",
    standard: { input: 8, cacheRead: 2, output: 28 },
  },
  "glm-5": {
    currency: "CNY",
    standard: { input: 4, cacheRead: 1, output: 18 },
  },
  "glm-4.7": {
    currency: "CNY",
    standard: { input: 2, cacheRead: 0.4, output: 8 },
  },

  // ── 火山方舟 Doubao（人民币）────────────────────────────────────
  // 来源 https://www.volcengine.com/docs/82379/1544106
  // 显式缓存另收缓存存储费 0.017 元/百万 token/小时（隐式缓存不收），
  // 存储费按小时计，本模块按 token 计费，故不计入。
  "doubao-seed-2.1-pro": {
    currency: "CNY",
    standard: { input: 6, cacheRead: 1.2, output: 30 },
  },
  "doubao-seed-2.1-turbo": {
    currency: "CNY",
    standard: { input: 3, cacheRead: 0.6, output: 15 },
  },

  // ── 阿里云百炼 Qwen（人民币）────────────────────────────────────
  // 输入/输出价来源 https://help.aliyun.com/zh/model-studio/billing-for-model-studio
  // 缓存倍率来源 https://help.aliyun.com/zh/model-studio/context-cache
  // 官方缓存只给倍率：显式缓存创建按输入价 125%、命中 10%；隐式缓存命中 20%。
  // 这里按「显式缓存」折算成绝对值（命中 10%），走隐式缓存的话命中价应是 20%。
  "qwen3-max": {
    currency: "CNY",
    standard: { input: 2.5, cacheRead: 0.25, output: 10, cacheWrite: 3.125 },
  },
  "qwen-plus": {
    currency: "CNY",
    standard: { input: 0.8, cacheRead: 0.08, output: 2, cacheWrite: 1 },
  },
  "qwen-flash": {
    currency: "CNY",
    standard: {
      input: 0.15,
      cacheRead: 0.015,
      output: 1.5,
      cacheWrite: 0.1875,
    },
  },

  // ── Anthropic Claude（美元）─────────────────────────────────────
  // 来源 https://aws.amazon.com/bedrock/pricing/ （本机访问不到 Anthropic 自家价目页）
  // 缓存的倍数与 Anthropic 公布的 1.25× 写入 / 0.1× 读取一致；
  // cacheWrite 是 5 分钟 TTL 档，1 小时 TTL 是它的两倍。
  "claude-sonnet-5-5": {
    currency: "USD",
    standard: { input: 2, cacheRead: 0.2, output: 10, cacheWrite: 2.5 },
  },
  "claude-opus-5-5": {
    currency: "USD",
    standard: { input: 4, cacheRead: 0.2, output: 20, cacheWrite: 5 },
  },
  "claude-haiku-4-5": {
    currency: "USD",
    standard: { input: 1, cacheRead: 0.1, output: 5, cacheWrite: 1.25 },
  },
};

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 把时刻换算到北京时间的 HH:MM，用于日志自证（中国无夏令时）。 */
export function beijingClock(at: Date): string {
  return new Date(at.getTime() + BEIJING_OFFSET_MS).toISOString().slice(11, 16);
}

/**
 * 是否处于官方定义的「高峰时段」（空闲价的两倍）。
 * 按北京时间判断：周一至周五 09:00-12:00、14:00-18:00；其余时段（含周末）全天空闲。
 * 中国法定节假日未建模 —— 那几天会按高峰价算。
 */
export function isPeakHour(at: Date = new Date()): boolean {
  const beijing = new Date(at.getTime() + BEIJING_OFFSET_MS);
  const weekday = beijing.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;

  const hour = beijing.getUTCHours();
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
}

/** 取某模型在 at 时刻适用的单价；表里没有的模型返回 undefined。 */
export function getPricing(
  model: string,
  at: Date = new Date(),
): ResolvedPricing | undefined {
  const entry = PRICE_TABLE[model];
  if (!entry) return undefined;

  if (!entry.peak)
    return { currency: entry.currency, tier: "flat", ...entry.standard };
  return entry.peak && isPeakHour(at)
    ? { currency: entry.currency, tier: "peak", ...entry.peak }
    : { currency: entry.currency, tier: "offPeak", ...entry.standard };
}

/** 人类可读的计费档描述，供日志自证：「高峰价（北京 10:30）」。 */
export function describePricing(model: string, at: Date = new Date()): string {
  const pricing = getPricing(model, at);
  if (!pricing) return "价格表未收录该模型";
  if (pricing.tier === "flat") return "标准价";
  const label = pricing.tier === "peak" ? "高峰价" : "空闲价";
  return `${label}（北京 ${beijingClock(at)}）`;
}

export interface StepUsage {
  /** 输入 token，缓存未命中 */
  noCacheInputTokens: number;
  /** 输入 token，缓存命中 */
  cacheReadTokens: number;
  /** 输入 token，写入缓存。DeepSeek 不返回该项，正常恒为 0 */
  cacheWriteTokens: number;
  /** 输出 token，已含 reasoning token */
  outputTokens: number;
}

const EMPTY_USAGE: StepUsage = {
  noCacheInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
};

const toCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * 把 AI SDK 的 usage 规范化成四个计费桶。
 *
 * AI SDK v7 的 LanguageModelUsage 形状：
 *   { inputTokens, inputTokenDetails: { noCacheTokens, cacheReadTokens, cacheWriteTokens },
 *     outputTokens, outputTokenDetails, totalTokens, raw? }
 * 缓存字段只能走 inputTokenDetails：usage 上根本没有 providerMetadata 字段
 * （provider 元数据在 result.finalStep.providerMetadata 上），
 * 而 v7 里顶层的 cachedInputTokens / reasoningTokens 已被移除。
 *
 * inputTokens 是「含缓存的输入总量」，实测 openai 兼容端点下
 * inputTokens = noCacheTokens + cacheReadTokens（官方 prompt_tokens = hit + miss），
 * 因此未命中桶用「总量 - 命中 - 写入」推出，保证四个桶加起来就是 provider 报的总量，
 * 不会把缓存命中重复计入未命中价。
 */
export function normalizeUsage(
  usage: LanguageModelUsage | null | undefined,
): StepUsage {
  if (!usage) return { ...EMPTY_USAGE };

  const details = usage.inputTokenDetails;
  const cacheReadTokens = toCount(details?.cacheReadTokens);
  const cacheWriteTokens = toCount(details?.cacheWriteTokens);
  const noCacheInputTokens = Math.max(
    0,
    usage.inputTokens !== undefined
      ? usage.inputTokens - cacheReadTokens - cacheWriteTokens
      : toCount(details?.noCacheTokens),
  );

  return {
    noCacheInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: toCount(usage.outputTokens),
  };
}

/**
 * 估算一步的成本，单位是价格表里那个模型的官方币种。
 * 价格表没有的模型返回 undefined —— 由调用方负责提示，不要静默当成 0。
 */
export function estimateCost(
  model: string,
  usage: StepUsage,
  at: Date = new Date(),
): { currency: Currency; cost: number } | undefined {
  const pricing = getPricing(model, at);
  if (!pricing) return undefined;

  // 缓存写入费：官方单列就按它算；没单列（DeepSeek）就按未命中价计，属保守高估。
  const cacheWritePrice = pricing.cacheWrite ?? pricing.input;
  const cost =
    (usage.noCacheInputTokens * pricing.input +
      usage.cacheWriteTokens * cacheWritePrice +
      usage.cacheReadTokens * pricing.cacheRead +
      usage.outputTokens * pricing.output) /
    1_000_000;

  return { currency: pricing.currency, cost };
}

export interface StepRecord extends StepUsage {
  /** 记录时刻（毫秒） */
  ts: number;
  model: string;
  /** 该步成本，币种见 currency（按记录时刻的高峰/标准档计算） */
  cost: number;
  currency: Currency;
}

export interface CurrencyCost {
  cost: number;
  /** 假想成本：把输入全部按未命中价算，用于估算缓存省了多少钱 */
  baselineCost: number;
  savedCost: number;
}

export interface UsageTotals {
  steps: number;
  noCacheInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** 缓存命中率 = 命中 / (未命中 + 命中 + 写入) */
  cacheHitRate: number;
  /**
   * 按币种分开累计。不同 provider 的官方价目币种不同（国内是元、海外是美元），
   * 混加成一个是算错的。
   */
  byCurrency: Partial<Record<Currency, CurrencyCost>>;
}

export class UsageTracker {
  private steps: StepRecord[] = [];
  private warnedModels = new Set<string>();
  private logPath?: string;

  constructor(logPath?: string) {
    this.logPath = logPath;
    if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  }

  record(model: string, usage: StepUsage): StepRecord {
    const estimate = estimateCost(model, usage);

    // 价格表缺这个模型时成本会静默变 0 —— 这里至少喊一次，让"价格拿错"看得见
    if (!estimate && !this.warnedModels.has(model)) {
      this.warnedModels.add(model);
      console.warn(
        `  [用量] 价格表没有模型 "${model}"，成本按 0 计。核对官方价目页后补进 PRICE_TABLE。`,
      );
    }

    const record: StepRecord = {
      ts: Date.now(),
      model,
      cost: estimate?.cost ?? 0,
      currency: estimate?.currency ?? "CNY",
      ...usage,
    };
    this.steps.push(record);
    if (this.logPath) {
      appendFileSync(this.logPath, JSON.stringify(record) + "\n", "utf-8");
    }

    return record;
  }

  /** 已记录的步数，可作为 totals(from) 的起点。 */
  get stepCount(): number {
    return this.steps.length;
  }

  /** 汇总第 from 步之后（含）的记录；from = stepCount 时用于取「本轮」增量。 */
  totals(from = 0): UsageTotals {
    const steps = this.steps.slice(from);
    const byCurrency: Partial<Record<Currency, CurrencyCost>> = {};
    let noCacheInputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let outputTokens = 0;

    for (const step of steps) {
      noCacheInputTokens += step.noCacheInputTokens;
      cacheReadTokens += step.cacheReadTokens;
      cacheWriteTokens += step.cacheWriteTokens;
      outputTokens += step.outputTokens;

      const bucket = (byCurrency[step.currency] ??= {
        cost: 0,
        baselineCost: 0,
        savedCost: 0,
      });
      bucket.cost += step.cost;

      const pricing = getPricing(step.model, new Date(step.ts));
      if (!pricing) continue; // 缺价格的步跳过，不能把已有累计清零
      const inputLikeTokens =
        step.noCacheInputTokens + step.cacheWriteTokens + step.cacheReadTokens;
      bucket.baselineCost +=
        (inputLikeTokens * pricing.input + step.outputTokens * pricing.output) /
        1_000_000;
    }

    for (const currency of Object.keys(byCurrency) as Currency[]) {
      const bucket = byCurrency[currency];
      if (bucket) bucket.savedCost = bucket.baselineCost - bucket.cost;
    }

    const inputLikeTokens =
      noCacheInputTokens + cacheReadTokens + cacheWriteTokens;
    return {
      steps: steps.length,
      noCacheInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      cacheHitRate: inputLikeTokens > 0 ? cacheReadTokens / inputLikeTokens : 0,
      byCurrency,
    };
  }
}

/** 按币种格式化金额；小于 1 分钱时多给几位小数，免得显示成全 0。 */
export function formatCost(value: number, currency: Currency): string {
  const amount = value < 0.01 ? value.toFixed(6) : value.toFixed(4);
  return `${CURRENCY_SYMBOL[currency]}${amount}`;
}

/** 一行话摘要，供 CLI 打印。 */
export function formatUsage(totals: UsageTotals): string {
  const costs = (Object.keys(totals.byCurrency) as Currency[]).map(
    (currency) => {
      const bucket = totals.byCurrency[currency];
      if (!bucket) return "";
      const saved = formatCost(bucket.savedCost, currency);
      return `${formatCost(bucket.cost, currency)}（缓存省 ${saved}）`;
    },
  );

  return [
    `${totals.steps} 步`,
    `输入 ${totals.noCacheInputTokens} 未命中 / ${totals.cacheReadTokens} 命中`,
    `输出 ${totals.outputTokens}`,
    `命中率 ${(totals.cacheHitRate * 100).toFixed(1)}%`,
    ...costs.filter(Boolean),
  ].join(" · ");
}
