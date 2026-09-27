import type { ToolDefinition } from "./tool-registry";
import { extname, join, relative, resolve } from "node:path";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import fg from "fast-glob";
import { execSync, spawn } from "node:child_process";
import { get as httpGet } from "node:http";
import { fileURLToPath } from "node:url";

export const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "查询指定城市的天气信息",
  isConcurrencySafe: true,
  isReadOnly: true,
  parameters: {
    type: "object",
    properties: {
      city: {
        type: "string",
        description: '城市名称，如"北京"、"上海"',
      },
    },
    required: ["city"],
    additionalProperties: false,
  },
  execute: async ({ city }: { city: string }) => {
    // 先用假数据，后面课程会接真实 API
    const mockWeather: Record<string, string> = {
      北京: "晴，15-25°C，东南风 2 级",
      上海: "多云，18-22°C，西南风 3 级",
      深圳: "阵雨，22-28°C，南风 2 级",
    };
    return mockWeather[city] || `${city}：暂无数据`;
  },
};

export const calculatorTool: ToolDefinition = {
  name: "calculator",
  description: "计算数学表达式的结果。当用户提问涉及数学运算时使用",
  parameters: {
    type: "object",
    properties: {
      expression: { type: "string", description: '数学表达式，如 "2 + 3 * 4"' },
    },
    required: ["expression"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({ expression }: { expression: string }) => {
    try {
      // 生产环境不要用 eval，这里纯粹为了演示
      const result = new Function(`return ${expression}`)();
      return `${expression} = ${result}`;
    } catch {
      return `无法计算: ${expression}`;
    }
  },
};

export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "读取指定路径的文件内容",
  isConcurrencySafe: true,
  isReadOnly: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
    },
    required: ["path"],
    additionalProperties: false,
  },
  execute: async ({ path }: { path: string }) => {
    return readFileSync(resolve(path), "utf-8");
  },
  maxResultChars: 500,
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

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    '按模式搜索文件。支持 * 和 ** 通配符，如 "src/**/*.ts" 匹配 src 下所有 TypeScript 文件',
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: '搜索模式，如 "**/*.ts"、"src/*.json"',
      },
      path: { type: "string", description: "搜索起始目录，默认当前目录" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({
    pattern,
    path = ".",
  }: {
    pattern: string;
    path?: string;
  }) => {
    const results = await fg(pattern, {
      cwd: resolve(path),
      ignore: ["node_modules/**", ".git/**"],
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
    });
    if (results.length === 0) return `没有找到匹配 "${pattern}" 的文件`;
    return results.sort().join("\n");
  },
};

export const grepTool: ToolDefinition = {
  name: "grep",
  description: "在文件中搜索匹配指定模式的内容。返回匹配的行号和内容",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "搜索模式（正则表达式）" },
      path: {
        type: "string",
        description: "搜索路径（文件或目录），默认当前目录",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({
    pattern,
    path = ".",
  }: {
    pattern: string;
    path?: string;
  }) => {
    const baseDir = resolve(path);
    const regex = new RegExp(pattern, "i");
    const matches: string[] = [];
    const SKIP = new Set(["node_modules", ".git", "dist"]);
    const BIN_EXT = new Set([
      ".png",
      ".jpg",
      ".gif",
      ".woff",
      ".woff2",
      ".ico",
      ".lock",
    ]);

    function searchFile(filePath: string) {
      if (matches.length >= 50) return;
      const ext = filePath.slice(filePath.lastIndexOf("."));
      if (BIN_EXT.has(ext)) return;

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        return;
      }

      const lines = content.split("\n");
      const rel = relative(baseDir, filePath);
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
          if (matches.length >= 50) return;
        }
      }
    }

    function walk(dir: string) {
      if (matches.length >= 50) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }

      for (const name of entries) {
        if (SKIP.has(name)) continue;
        const full = join(dir, name);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) walk(full);
          else searchFile(full);
        } catch {
          /* skip */
        }
      }
    }

    const stat = statSync(baseDir);
    if (stat.isFile()) {
      searchFile(baseDir);
    } else {
      walk(baseDir);
    }

    if (matches.length === 0) return `没有找到匹配 "${pattern}" 的内容`;
    const suffix =
      matches.length >= 50 ? "\n... (结果已截断，共 50+ 条匹配)" : "";
    return matches.join("\n") + suffix;
  },
};

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "执行 shell 命令并返回输出。适合运行脚本、检查环境、执行构建等操作",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  maxResultChars: 3000,
  execute: async ({ command }: { command: string }) => {
    // 先检测环境是否支持 child_process
    try {
      execSync("echo test", { stdio: "ignore" });
    } catch {
      return `[bash 不可用] 当前环境不支持 shell 命令。本地终端运行可使用。`;
    }

    // 执行命令
    try {
      const output = execSync(command, {
        encoding: "utf-8",
        timeout: 10000, // 10 秒超时
        maxBuffer: 1024 * 1024,
      });
      return output || "(命令执行成功，无输出)";
    } catch (err: any) {
      return `命令执行失败 (exit ${err.status || 1}):\n${err.stderr || err.message}`;
    }
  },
};

export const fetchUrlTool: ToolDefinition = {
  name: "fetch_url",
  description: "抓取指定 URL 的网页内容并转换为纯文本（自动剥离 HTML 标签）",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "完整 URL，必须以 http:// 或 https:// 开头",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 1500,
  execute: async ({ url }: { url: string }) => {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 SuperAgent" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return `请求失败：HTTP ${res.status}`;
      const html = await res.text();

      return (
        html
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim() || "页面无文本内容"
      );
    } catch (err: any) {
      return `抓取 URL 失败: ${err.message}`;
    }
  },
};

// 预览服务器的端口占用探测：服务器跑在独立子进程里，主进程无法直接持有其状态，
// 因此通过尝试连接来判断端口是否已被（本工具或其它进程）占用。
function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const req = httpGet(`http://localhost:${port}/`, (res) => {
      res.resume(); // 丢弃响应体，只关心能否连上
      resolvePromise(true);
    });
    req.on("error", () => resolvePromise(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolvePromise(false);
    });
  });
}

// 子进程脚本路径（与本文件同目录），用 fileURLToPath 兼容 ESM
const previewServerScript = fileURLToPath(
  new URL("./preview-server.ts", import.meta.url),
);

export const startPreviewTool: ToolDefinition = {
  name: "start_preview",
  description: "启动 app/ 目录的预览服务器。生成应用文件后必须立即调用此工具",
  parameters: {
    type: "object",
    properties: { port: { type: "number" } },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ port = 8080 }: { port?: number } = {}) => {
    const root = resolve("app");
    if (!existsSync(root)) return "错误：app/ 目录不存在";

    // 已有进程占用该端口（可能是上次启动的常驻服务器），直接复用，避免重复启动
    if (await isPortBusy(port)) {
      return `预览服务器已在运行 → http://localhost:${port}`;
    }

    // 以 detached 子进程方式启动静态服务器：主进程退出后它仍常驻，浏览器随时可访问。
    // stdio: "ignore" + unref() 让子进程完全脱离主进程，不阻塞主进程退出。
    const child = spawn(
      process.execPath,
      ["--import", "tsx", previewServerScript, root, String(port)],
      { detached: true, stdio: "ignore" },
    );
    child.unref();

    // 等服务器真正开始监听（或失败退出）后再返回，避免「还没起来就报成功」
    return new Promise<string>((resolvePromise) => {
      const deadline = Date.now() + 5000;
      const timer = setInterval(async () => {
        if (await isPortBusy(port)) {
          clearInterval(timer);
          resolvePromise(`✓ 预览服务器已启动 → http://localhost:${port}`);
        } else if (child.exitCode !== null) {
          clearInterval(timer);
          resolvePromise(
            `错误：预览服务器启动失败（子进程退出码 ${child.exitCode}）。端口 ${port} 可能被占用。`,
          );
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          resolvePromise(
            `错误：预览服务器启动超时（5 秒内未监听端口 ${port}）。`,
          );
        }
      }, 150);
    });
  },
};

export const stopPreviewTool: ToolDefinition = {
  name: "stop_preview",
  description:
    "停止指定端口的预览服务器。preview 服务器是独立常驻进程，不随主进程退出，需用本工具显式停止",
  parameters: {
    type: "object",
    properties: { port: { type: "number" } },
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({ port = 8080 }: { port?: number } = {}) => {
    // 服务器跑在独立 detached 子进程里，主进程拿不到它的句柄，
    // 只能通过端口反查监听 PID（lsof -ti）再 kill。
    if (!(await isPortBusy(port))) {
      return `端口 ${port} 上没有运行中的预览服务器`;
    }
    try {
      const pids = execSync(`lsof -ti:${port}`, { encoding: "utf-8" })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (pids.length === 0) {
        return `端口 ${port} 上找不到监听进程`;
      }
      for (const pid of pids) {
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {
          // 进程可能已退出或权限不足，忽略并继续处理其它 PID
        }
      }
      // 给进程一点退出时间，再确认端口已释放
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        if (!(await isPortBusy(port))) {
          return `✓ 已停止端口 ${port} 上的预览服务器（PID ${pids.join(", ")}）`;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      return `已向 PID ${pids.join(", ")} 发送停止信号，但端口 ${port} 仍被占用`;
    } catch (err) {
      return `错误：停止预览服务器失败：${(err as Error).message}`;
    }
  },
};

export const allTools: ToolDefinition[] = [
  // weatherTool,
  // calculatorTool,
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  editFileTool,
  globTool,
  grepTool,
  bashTool,
  fetchUrlTool,
  startPreviewTool,
  stopPreviewTool,
];
