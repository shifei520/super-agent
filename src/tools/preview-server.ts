// 独立的预览静态服务器，由 start_preview 工具以 detached 子进程方式启动。
// 关键是脱离 Agent 主进程的生命周期：主进程退出后本进程继续常驻，浏览器随时可访问。
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".tsx": "application/javascript; charset=utf-8",
  ".ts": "application/javascript; charset=utf-8",
  ".jsx": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

// 入参：preview-server.ts <root> <port>
const root = resolve(process.argv[2] ?? "app");
const port = Number(process.argv[3] ?? 8080);

if (!existsSync(root)) {
  console.error(`[preview-server] 目录不存在：${root}`);
  process.exit(1);
}

const server = createServer((req, res) => {
  // 去掉查询串；目录路径补 index.html
  let urlPath = req.url?.split("?")[0] || "/";
  if (urlPath.endsWith("/")) urlPath += "index.html";

  // 先归一化再做前缀校验，防止 ../ 路径穿越
  const filePath = resolve(root, "." + urlPath);

  try {
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    res.writeHead(200, {
      "Content-Type":
        MIME[extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(readFileSync(filePath));
  } catch {
    res.writeHead(404);
    res.end("Not Found");
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  // 以退出码区分端口占用，方便父进程排错
  console.error(
    err.code === "EADDRINUSE"
      ? `[preview-server] 端口 ${port} 已被占用`
      : `[preview-server] 启动失败：${err.message}`,
  );
  process.exit(1);
});

server.listen(port, () => {
  console.log(`[preview-server] 已启动 → http://localhost:${port}（根目录 ${root}）`);
});
