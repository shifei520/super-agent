export type ScheduleType = 'cron' | 'interval' | 'once'

export interface CronJobConfig {
  id: string // 任务唯一标识
  name: string
  description?: string
  schedule: string // 调度表达式：cron 五字段 | "every 30s" | ISO 时间戳
  scheduleType: ScheduleType // 解析后的调度类型
  timeout?: number
  enabled: boolean // 是否启用
  payload: JobPayload // 执行内容（agent prompt 或 handler 回调）
  maxRetries?: number
  source: 'runtime' | 'config' // 来源：config 不可删，runtime 可增删
}

// 把 prompt 交给 Agent Loop 执行
// 调用插件注册的 handler 函数
export type JobPayload = { type: 'agent', prompt: string } | { type: 'handler', handler: string }

export interface RunLog {
  jobId: string // 所属任务 ID
  startedAt: string
  finishedAt: string
  status: 'success' | 'error' | 'timeout'
  output?: string
  error?: string
}

/** 运行时任务配置 */
export interface CronJobState {
  config: CronJobConfig // 任务配置
  timerId: ReturnType<typeof setTimeout> | null // 当前定时器句柄
  lastRun?: RunLog // 上一次执行记录
  consecutiveFailures: number // 连续失败计数
  running: boolean // 是否正在执行中
}