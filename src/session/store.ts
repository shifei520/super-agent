import type { ModelMessage } from "ai";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SESSION_DIR = ".sessions";

export interface SessionEntry {
  type: "message";
  timestamp: string;
  message: ModelMessage;
}

export class SessionStore {
  private dir: string;
  private sessionId: string;

  constructor(sessionId: string = "default") {
    this.dir = SESSION_DIR;
    this.sessionId = sessionId;

    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  private get filePath(): string {
    return join(this.dir, `${this.sessionId}.jsonl`);
  }

  append(message: ModelMessage) {
    const entry: SessionEntry = {
      type: "message",
      timestamp: new Date().toISOString(),
      message,
    };
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
  }

  appendAll(messages: ModelMessage[]) {
    for (const message of messages) {
      this.append(message);
    }
  }

  load(): ModelMessage[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf-8").trim();
    if (!content) return [];

    const messages: ModelMessage[] = [];

    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const entry: SessionEntry = JSON.parse(line);
        if (entry.type === "message") {
          messages.push(entry.message);
        }
      } catch {}
    }
    return messages;
  }

  exists() {
    return existsSync(this.filePath);
  }
}
