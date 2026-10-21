import type { MemoryEntry } from "./store";
import path from 'node:path'
import fs from 'node:fs'

export interface ValidationIssue {
  kind: 'stale_path' | 'never_used' | 'duplicate_name';
  message: string
}

export interface ValidationReport {
  issues: ValidationIssue[]
  entry: MemoryEntry
}

const TTL_BY_TYPE: Record<string, number> = {
  user: 365,
  feedback: 90,
  project: 30,
  reference: 14,
};

const PATH_RE = /(?<![\w/])([\w./-]+\.(?:ts|tsx|js|jsx|json|md|mdx|sql|yml|yaml|toml|env|sh|py))/g;

export function extractPaths(content: string): string[] {
  const paths = new Set<string>();
  for (const match of content.matchAll(PATH_RE)) {
    paths.add(match[1]);
  }
  return Array.from(paths);
}

export function validateEntry(entry: MemoryEntry, baseDir: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  // 1、检查路径是否过期

  // 抽取内容中的路径
  const paths = extractPaths(entry.content)
  for (const p of paths) {
    const absPath = path.isAbsolute(p) ? p : path.join(baseDir, p)
    if (!fs.existsSync(absPath)) {
      issues.push({ kind: 'stale_path', message: `引用的路径不存在：${p}` })
    }
  }

  // TTL过期
  if (entry.lastReadAt) {
    const staleDays = TTL_BY_TYPE[entry.type] ?? 0
    const days = (Date.now() - entry.lastReadAt) / (1000 * 60 * 60 * 24)
    if (days > staleDays) {
      issues.push({
        kind: 'never_used',
        message: `已 ${Math.floor(days)} 天没被读过，超过 ${entry.type} 类型的 ${staleDays} 天保质期`,
      });
    }
  }

  return issues
}

export function lintAll(entries: MemoryEntry[], baseDir: string): ValidationReport[] {
  const reports: ValidationReport[] = []

  const entryNameMap = new Map<string, number>()
  // 3、跟别的记忆重名
  for (const e of entries) {
    entryNameMap.set(e.name, (entryNameMap.get(e.name) || 0) + 1);
  }

  for (const entry of entries) {
    const issues = validateEntry(entry, baseDir)

    if ((entryNameMap.get(entry.name) || 0) > 1) {
      issues.push({
        kind: 'duplicate_name',
        message: `存在 ${entryNameMap.get(entry.name)} 条同名记忆，可能需要合并`,
      });
    }
    if (issues.length) {
      reports.push({
        entry,
        issues
      })
    }
  }

  return reports
}