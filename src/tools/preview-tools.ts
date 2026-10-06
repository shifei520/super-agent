import type { ToolDefinition } from "./tool-registry";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { get as httpGet } from "node:http";
import { fileURLToPath } from "node:url";

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
