import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { ToolDefinition } from "./tool-registry";
import { join, resolve } from "node:path";

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description:
    "读取指定路径的文件内容。支持 offset/limit 按行分页读取大文件：offset 为起始行号（从 1 开始），limit 为读取行数",
  isConcurrencySafe: true,
  isReadOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      offset: {
        type: "number",
        description: "起始行号（从 1 开始），不指定则从文件开头读取",
      },
      limit: {
        type: "number",
        description: "读取的行数，不指定则读到文件末尾",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async ({
    path,
    offset,
    limit,
  }: {
    path: string;
    offset?: number;
    limit?: number;
  }) => {
    const content = readFileSync(resolve(path), "utf-8");

    // 未指定分页参数时直接返回全文（超长的部分由 maxResultChars 兜底截断）
    if (offset === undefined && limit === undefined) {
      return content;
    }

    const lines = content.split("\n");
    const start = Math.max(0, (offset ?? 1) - 1);
    const selected =
      limit !== undefined
        ? lines.slice(start, start + limit)
        : lines.slice(start);

    if (selected.length === 0) {
      return `[文件共 ${lines.length} 行，起始行 ${start + 1} 超出范围]`;
    }
    // 附上位置信息，方便模型判断是否需要继续翻页
    const header = `[文件共 ${lines.length} 行，本次返回第 ${start + 1}-${start + selected.length} 行]`;
    return `${header}\n${selected.join("\n")}`;
  },
  maxResultChars: 50000,
};

export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "写入内容到指定文件",
  isConcurrencySafe: false,
  isReadOnly: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      content: { type: "string", description: "要写入的内容" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  execute: async ({ path, content }: { path: string; content: string }) => {
    writeFileSync(resolve(path), content, "utf-8");
    return `已写入 ${content.length} 字符到 ${path}`;
  },
};

export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "列出指定目录下的文件和子目录",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录路径，默认为当前目录" },
    },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ path = "." }: { path: string }) => {
    const resolvedPath = resolve(path);
    return readdirSync(resolvedPath)
      .map((name) => {
        const stat = statSync(join(resolvedPath, name));
        return `${stat.isDirectory() ? "[DIR]" : "[FILE]"} ${name}`;
      })
      .join("\n");
  },
};

export const editFileTool: ToolDefinition = {
  name: "edit_file",
  description:
    "精确替换文件中的指定内容。用 old_string 定位要替换的文本，用 new_string 替换它。不是全量覆写——只改你指定的部分",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      old_string: {
        type: "string",
        description: "要被替换的原始文本（必须精确匹配）",
      },
      new_string: { type: "string", description: "替换后的新文本" },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({
    path,
    old_string,
    new_string,
  }: {
    path: string;
    old_string: string;
    new_string: string;
  }) => {
    const resolved = resolve(path);
    if (!existsSync(resolved)) {
      return `文件不存在: ${path}`;
    }

    const content = readFileSync(resolved, "utf-8");
    const count = content.split(old_string).length - 1;

    if (count === 0) {
      return `未找到匹配内容。请检查 old_string 是否与文件中的文本完全一致（包括空格和换行）`;
    }
    if (count > 1) {
      return `找到 ${count} 处匹配，请提供更多上下文让 old_string 唯一`;
    }

    const updatedContent = content.replace(old_string, new_string);
    writeFileSync(resolved, updatedContent, "utf-8");
    return `已替换 ${path} 中的内容（${old_string.length} → ${new_string.length} 字符）`;
  },
};
