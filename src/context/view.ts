/**
 * /context 终端可视化——参考 Claude Code 的 /context 视图。
 *
 * 把 context 占用按"类别"切片画成方块矩阵，每格 ≈ window 的 1/256（16x16）。
 * 不同类别用不同颜色（ANSI 256 色），让"谁在吃 context"一眼看清楚。
 */
import type { ModelMessage } from "ai";
import type { Currency, UsageTracker } from "../usage/tracker.js";
import { formatCost } from "../usage/tracker.js";

export interface ContextSlice {
  name: string;
  tokens: number;
  color: number; // ANSI 256 color code
  icon: string;
}

export interface ContextSnapshot {
  modelName: string;
  modelId: string;
  windowTokens: number;
  usedTokens: number;
  slices: ContextSlice[];
  // 预留给 autocompact，用户聊得越深这个越小
  autocompactBufferTokens: number;
}

const COLORS = {
  system: 63, // 紫
  tools: 99, // 紫粉
  messages: 111, // 蓝
  free: 240, // 灰（空格子）
  buffer: 244, // 灰（autocompact buffer）
  text: 255, // 白文字
  dim: 244, // 暗灰
};

function fg(code: number, s: string): string {
  return `\x1b[38;5;${code}m${s}\x1b[0m`;
}

function pct(n: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((n / total) * 100).toFixed(1)}%`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * 画一个 16×16 = 256 格的矩阵，每格代表 window/256 个 tokens。
 * 已用部分按 slices 顺序填彩色 ●，free 用 ○，autocompact buffer 用 ▢。
 */
export function renderContextMatrix(snapshot: ContextSnapshot): string {
  const { windowTokens, slices, autocompactBufferTokens } = snapshot;
  const TOTAL_CELLS = 256;
  const tokensPerCell = windowTokens / TOTAL_CELLS;

  // 把每个 slice 的 token 数转成"格子数"（向上取整避免 0 格丢失）
  const cells: number[] = []; // ANSI color for each cell, or -1 for free, -2 for buffer
  let used = 0;
  for (const s of slices) {
    if (s.tokens <= 0) continue;
    const n = Math.max(1, Math.round(s.tokens / tokensPerCell));
    for (let i = 0; i < n && cells.length < TOTAL_CELLS; i++) {
      cells.push(s.color);
    }
    used += n;
  }
  const bufferCells = Math.max(
    0,
    Math.round(autocompactBufferTokens / tokensPerCell),
  );
  const freeCells = TOTAL_CELLS - cells.length - bufferCells;
  for (let i = 0; i < freeCells; i++) cells.push(-1);
  for (let i = 0; i < bufferCells && cells.length < TOTAL_CELLS; i++)
    cells.push(-2);

  const lines: string[] = [];
  for (let row = 0; row < 16; row++) {
    const rowCells: string[] = [];
    for (let col = 0; col < 16; col++) {
      const idx = row * 16 + col;
      const c = cells[idx];
      if (c === -1) rowCells.push(fg(COLORS.free, "○"));
      else if (c === -2) rowCells.push(fg(COLORS.buffer, "▢"));
      else rowCells.push(fg(c, "●"));
    }
    lines.push(rowCells.join(" "));
  }
  return lines.join("\n");
}

export function renderContextLegend(snapshot: ContextSnapshot): string {
  const { slices, autocompactBufferTokens, windowTokens, usedTokens } =
    snapshot;
  const lines: string[] = [];

  lines.push(`\x1b[1m${fg(COLORS.text, snapshot.modelName)}\x1b[0m`);
  lines.push(fg(COLORS.dim, snapshot.modelId));
  lines.push(
    `${fmtTokens(usedTokens)}/${fmtTokens(windowTokens)} tokens (${pct(usedTokens, windowTokens)})`,
  );
  lines.push("");
  lines.push(fg(COLORS.dim, "\x1b[3mEstimated usage by category\x1b[0m"));
  for (const s of slices) {
    if (s.tokens <= 0) continue;
    const dot = fg(s.color, "●");
    const label = `${s.icon} ${s.name}`;
    const value = `${fmtTokens(s.tokens)} tokens (${pct(s.tokens, windowTokens)})`;
    lines.push(`${dot} ${label}: ${value}`);
  }
  const free = windowTokens - usedTokens - autocompactBufferTokens;
  lines.push(
    `${fg(COLORS.free, "○")}  Free space: ${fmtTokens(Math.max(0, free))} (${pct(Math.max(0, free), windowTokens)})`,
  );
  lines.push(
    `${fg(COLORS.buffer, "▢")}  Autocompact buffer: ${fmtTokens(autocompactBufferTokens)} (${pct(autocompactBufferTokens, windowTokens)})`,
  );

  return lines.join("\n");
}

/**
 * 并排显示矩阵 + 图例。简单按行拼接，矩阵在左、图例在右。
 */
export function renderContextView(snapshot: ContextSnapshot): string {
  const matrix = renderContextMatrix(snapshot).split("\n");
  const legend = renderContextLegend(snapshot).split("\n");
  const rows = Math.max(matrix.length, legend.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const left = (matrix[i] || "").padEnd(80, " ");
    const right = legend[i] || "";
    out.push(`  ${left}  ${right}`);
  }
  return "\n" + out.join("\n") + "\n";
}

// ── Snapshot 构造：从消息列表 + 各种已知尺寸算 token 切片 ─────────

export interface BuildSnapshotInput {
  modelName: string; // "Mock Model" / "Qwen Plus" 等
  modelId: string;
  windowTokens: number; // 比如 128_000
  /** system prompt 字符数（SYSTEM.length），内部按 CHARS_PER_TOKEN 折算 token */
  systemPromptChars: number;
  /**
   * 活跃工具的 token 估算，直接取 toolRegistry.countTokenEstimate().active
   * （registry 内部已按 ~4 字符/token 折好，这里不再二次折算）
   */
  toolTokens: number;
  messages: ModelMessage[];
  autocompactBufferTokens?: number;
}

const CHARS_PER_TOKEN = 3.5;
function approxTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function approxMessageTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content as any[]) {
        if (part.type === "text") chars += (part.text || "").length;
        else if (part.type === "tool-call")
          chars += JSON.stringify(part.input || {}).length + 80;
        else if (part.type === "tool-result") {
          const out = part.output;
          if (typeof out === "string") chars += out.length;
          else if (out?.value) chars += String(out.value).length;
          else chars += JSON.stringify(out || {}).length;
          chars += 80;
        }
      }
    }
  }
  return approxTokensFromChars(chars);
}

export function buildContextSnapshot(
  input: BuildSnapshotInput,
): ContextSnapshot {
  const slices: ContextSlice[] = [
    {
      name: "System prompt",
      tokens: approxTokensFromChars(input.systemPromptChars),
      color: COLORS.system,
      icon: "◆",
    },
    {
      name: "System tools",
      tokens: input.toolTokens,
      color: COLORS.tools,
      icon: "◇",
    },
    {
      name: "Messages",
      tokens: approxMessageTokens(input.messages),
      color: COLORS.messages,
      icon: "◎",
    },
  ];
  const usedTokens = slices.reduce((a, s) => a + s.tokens, 0);
  return {
    modelName: input.modelName,
    modelId: input.modelId,
    windowTokens: input.windowTokens,
    usedTokens,
    slices,
    autocompactBufferTokens:
      input.autocompactBufferTokens ?? Math.round(input.windowTokens * 0.05),
  };
}

// ── /usage 视图：累计成本 + cache 命中率 ─────────────────────────

export function renderUsageView(tracker: UsageTracker): string {
  const t = tracker.totals();
  const lines: string[] = [];
  const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " ");

  lines.push(bold(fg(COLORS.text, "  Usage Summary")));
  lines.push(fg(COLORS.dim, `  ${t.steps} 步累计 · ${stamp}`));
  lines.push("");
  lines.push(
    `  ${fg(111, "◎")} Input(未命中)  ${fmtTokens(t.noCacheInputTokens).padStart(8)} tokens`,
  );
  lines.push(
    `  ${fg(220, "◈")} Cache write   ${fmtTokens(t.cacheWriteTokens).padStart(8)} tokens`,
  );
  lines.push(
    `  ${fg(36, "◉")} Cache read    ${fmtTokens(t.cacheReadTokens).padStart(8)} tokens   (${(t.cacheHitRate * 100).toFixed(1)}% hit)`,
  );
  lines.push(
    `  ${fg(99, "◇")} Output        ${fmtTokens(t.outputTokens).padStart(8)} tokens`,
  );
  lines.push("");

  // Cache 命中率条
  const barWidth = 30;
  const filled = Math.round(t.cacheHitRate * barWidth);
  const bar =
    fg(36, "█".repeat(filled)) + fg(240, "░".repeat(barWidth - filled));
  lines.push(`  Cache hit rate  ${bar}  ${(t.cacheHitRate * 100).toFixed(1)}%`);
  lines.push("");

  // 成本按币种分组：不同 provider 官方币种不同（国内元 / 海外美元），混加成一个是算错的
  const currencies = Object.keys(t.byCurrency) as Currency[];
  if (currencies.length === 0) {
    lines.push(fg(COLORS.dim, "  尚无成本数据（价格表未收录当前模型？）"));
  } else {
    for (const currency of currencies) {
      const bucket = t.byCurrency[currency];
      if (!bucket) continue;
      const savedPct =
        bucket.baselineCost > 0
          ? (bucket.savedCost / bucket.baselineCost) * 100
          : 0;
      lines.push(bold(fg(COLORS.text, `  Cost · ${currency}`)));
      lines.push(
        `    ${fg(220, "实付")}      ${fg(220, formatCost(bucket.cost, currency))}`,
      );
      lines.push(
        `    ${fg(COLORS.dim, "无缓存")}    ${fg(COLORS.dim, formatCost(bucket.baselineCost, currency))}`,
      );
      if (bucket.savedCost > 0) {
        lines.push(
          `    ${fg(36, "已省")}      ${fg(36, `${formatCost(bucket.savedCost, currency)} (${savedPct.toFixed(1)}% off)`)}`,
        );
      }
      lines.push("");
    }
  }

  return "\n" + lines.join("\n").replace(/\s+$/, "") + "\n";
}
