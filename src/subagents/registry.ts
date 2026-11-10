import { DEFAULT_CONFIG, SubAgentConfig, SubAgentRun } from "./types";

export class SubAgentRegistry {
  private runs: Map<string, SubAgentRun> = new Map();
  private config: SubAgentConfig;
  private idCounter = 0;

  constructor(config?: Partial<SubAgentConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  generateId() {
    return `sub-${++this.idCounter}-${Date.now().toString(36).slice(-4)}`;
  }

  get(id: string) {
    return this.runs.get(id);
  }

  register(run: SubAgentRun) {
    this.runs.set(run.id, run);
  }

  complete(id: string, result: string) {
    const run = this.runs.get(id);
    if (!run) return;

    run.status = "completed";
    run.finishedAt = new Date().toISOString();
    run.result = result;
  }

  fail(id: string, error: string, timedOut = false) {
    const run = this.runs.get(id);
    if (!run) return;

    run.status = timedOut ? "timeout" : "error";
    run.finishedAt = new Date().toISOString();
    run.error = error;
  }

  getActiveRuns() {
    return Array.from(this.runs.values()).filter((r) => r.status === "running");
  }

  getAllRuns() {
    return Array.from(this.runs.values());
  }

  getConfig() {
    return this.config;
  }

  /** 能否继续派发 */
  canSpawn(currentDepth: number): { ok: boolean; reason?: string } {
    if (currentDepth >= this.config.maxSpawnDepth) {
      return {
        ok: false,
        reason: `已达最大嵌套深度 ${this.config.maxSpawnDepth}`,
      };
    }

    const activeCount = this.getActiveRuns().length;
    if (activeCount >= this.config.maxConcurrency) {
      return {
        ok: false,
        reason: `已达最大并发数 ${this.config.maxConcurrency}，等待现有任务完成`,
      };
    }

    return { ok: true };
  }
}
