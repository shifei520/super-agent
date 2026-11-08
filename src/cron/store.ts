import fs from 'node:fs'
import path from 'node:path'
import { RunLog, CronJobConfig } from './types';

const JOB_DIR = '.cron'
const JOBS_FILE = 'jobs.json';
const LOGS_FILE = 'logs.jsonl';

export class CronStore {
  private readonly baseDir: string

  constructor(baseDir = '.') {
    this.baseDir = baseDir
  }

  private get jobDirPath() {
    return path.join(this.baseDir, JOB_DIR)
  }
  private get jobsFilePath() {
    return path.join(this.jobDirPath, JOBS_FILE)
  }
  private get logsFilePath() {
    return path.join(this.jobDirPath, LOGS_FILE)
  }

  init() {
    if (!fs.existsSync(this.jobDirPath)) {
      fs.mkdirSync(this.jobDirPath, { recursive: true })
    }
  }

  loadJobs(): CronJobConfig[] {
    if (!fs.existsSync(this.jobsFilePath)) return []

    try {
      const data = JSON.parse(fs.readFileSync(this.jobsFilePath, 'utf-8'))
      return data.jobs || []
    } catch {
      return []
    }
  }

  saveJobs(jobs: CronJobConfig[]) {
    fs.writeFileSync(this.jobsFilePath, JSON.stringify({ jobs }, null, 2))
  }

  appendLog(log: RunLog) {
    fs.appendFileSync(this.logsFilePath, JSON.stringify(log) + '\n')
  }

  getRecentLogs(jobId?: string, limit = 10): RunLog[] {
    if (!fs.existsSync(this.logsFilePath)) return []

    const lines = fs.readFileSync(this.logsFilePath, 'utf-8').split('\n').filter(Boolean)

    let logs: RunLog[] = lines.map(l => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    }).filter(Boolean)

    if (jobId) {
      return logs.filter(l => l.jobId === jobId)
    }
    return logs.slice(-limit)
  }
}