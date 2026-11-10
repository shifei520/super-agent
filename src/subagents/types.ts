export interface SubAgentConfig {
  /** 最大嵌套深度，默认1 */
  maxSpawnDepth: number;
  /** 最大并发子agent数量，默认3 */
  maxConcurrency: number;
  /** 默认执行超时 ms，默认 60000 */
  defaultTimeout: number;
}

export const DEFAULT_CONFIG: SubAgentConfig = {
  maxSpawnDepth: 1,
  maxConcurrency: 3,
  defaultTimeout: 60000,
};

export interface SpawnRequest {
  task: string;
  tools?: string[];
  timeout?: number;
}

export interface SubAgentRun {
  id: string;
  task: string;
  status: "running" | "completed" | "error" | "timeout";
  depth: number;
  startedAt: string;
  finishedAt?: string;
  result?: string;
  error?: string;
}
