import fs from "node:fs"
import path from "node:path"

export interface SkillDefinition {
  name: string
  description: string
  whenToUse?: string
  content: string
  dirPath: string
}

const SKILLS_DIR = '.skills';
const SKILL_FILE = 'SKILL.md';

export class SkillLoader {
  private readonly baseDir: string
  private skills = new Map<string, SkillDefinition>()

  constructor(baseDir = ".") {
    this.baseDir = baseDir
  }

  load(): SkillDefinition[] {
    this.skills.clear()
    const skillsDir = path.join(this.baseDir, SKILLS_DIR)
    if (!fs.existsSync(skillsDir)) return []

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, SKILL_FILE)
      if (!fs.existsSync(skillFile)) continue;

      const raw = fs.readFileSync(skillFile, "utf-8")
      const parsed = this.parseFrontmatter(raw)
      if (!parsed) continue;

      this.skills.set(entry.name, {
        name: entry.name,
        description: parsed.description,
        content: parsed.content,
        dirPath: path.join(skillsDir, entry.name),
        whenToUse: parsed.whenToUse,
      })
    }

    return this.list()
  }

  buildPromptSection(activeSkills: Set<string>): string | null {
    if (this.skills.size === 0) return null
    const lines: string[] = []

    for (const name of activeSkills) {
      const skill = this.get(name)
      if (!skill) continue;
      lines.push(`[激活的 Skill: ${skill.name}]`);
      lines.push(`Skill目录: ${skill.dirPath}`)
      lines.push(skill.content);
      lines.push('');
    }

    const available = this.list()
      .filter(s => !activeSkills.has(s.name))
      .map(s => {
        const hint = s.whenToUse ? ` (适用场景: ${s.whenToUse})` : '';
        // 这里不带斜杠：模型会照抄列表里的名字作为 use_skill 的参数
        return `  - ${s.name} — ${s.description}${hint}`;
      });

    if (available.length > 0) {
      lines.push('可用的 Skills（调用 use_skill 工具激活，name 传下列名称，不带斜杠）：');
      lines.push(...available);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values())
  }

  private parseFrontmatter(raw: string): { description: string; content: string; whenToUse?: string } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return { description: '', content: raw };
    const meta: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
        meta[key] = value;
      }
    }
    return {
      description: meta.description || '',
      content: match[2].trim(),
      whenToUse: meta.when_to_use || undefined,
    };
  }
}