import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/* ======================================================================
 * 手写 MCP Client（学习用，已被下方官方 SDK 实现取代）
 * ----------------------------------------------------------------------
 * 保留这段是为了搞清楚 MCP over stdio 的底层原理：
 *
 *  1. 传输层：通过 child_process.spawn 拉起 MCP Server 子进程，
 *     通信走的是「子进程 stdin 写请求 / stdout 读响应」，每条消息是一行 JSON。
 *
 *  2. 协议层：JSON-RPC 2.0。
 *     - 请求  { jsonrpc:"2.0", id, method, params }
 *     - 响应  { jsonrpc:"2.0", id, result | error }   （用 id 与请求配对）
 *     - 通知  { jsonrpc:"2.0", method, params }        （无 id，不需要响应）
 *
 *  3. 握手流程（顺序很重要）：
 *     a. client 发 "initialize" 请求（带协议版本、能力、客户端信息）
 *     b. server 回 initialize 响应
 *     c. client 发 "notifications/initialized" 通知，告知握手完成
 *     d. 之后才能调 "tools/list" / "tools/call" 等方法
 *
 *  4. 并发配对：用自增 requestId + pedding(Map<id, {resolve,reject}>)，
 *     每收到一行 stdout 就 JSON.parse，按 msg.id 找到对应 Promise 结算；
 *     每个请求挂一个 setTimeout 做超时保护。
 *
 *  这些「配对 / 超时 / 握手 / 行解析」的脏活，官方 SDK 全都内置了，
 *  生产环境直接用下面的实现即可。
 * ====================================================================== */

// import { spawn, type ChildProcess } from "node:child_process";
// import { createInterface, type Interface } from "node:readline";
//
// interface MCPCallResult {
//   content: Array<{ type: string; text?: string }>;
//   isError?: boolean;
// }
//
// class MCPClientManual {
//   private process: ChildProcess | null = null;
//   private rl: Interface | null = null;
//   private requestId = 0;
//   private pedding = new Map<
//     number,
//     { resolve: (v: any) => void; reject: (e: Error) => void }
//   >();
//   private serverName: string;
//
//   constructor(
//     private command: string,
//     private args: string[],
//     private env?: Record<string, string>,
//   ) {
//     this.serverName =
//       args[args.length - 1]?.replace(/^@.*\//, "") || "mcp-server";
//   }
//
//   async connect() {
//     this.process = spawn(this.command, this.args, {
//       stdio: ["pipe", "pipe", "pipe"],
//       env: { ...process.env, ...this.env },
//     });
//
//     this.process.on("error", (err) => {
//       console.error(`  [MCP] 进程启动失败: ${err.message}`);
//     });
//     this.process.stderr?.on("data", (d) =>
//       console.error(`  [MCP stderr] ${d.toString().trim()}`),
//     );
//
//     this.rl = createInterface({ input: this.process.stdout! });
//     this.rl.on("line", (line) => {
//       try {
//         const msg = JSON.parse(line);
//         if (msg.id !== undefined && this.pedding.has(msg.id)) {
//           const p = this.pedding.get(msg.id)!;
//           this.pedding.delete(msg.id);
//           if (msg.error) {
//             p.reject(
//               new Error(`MCP error ${msg.error.code}: ${msg.error.message}`),
//             );
//           } else {
//             p.resolve(msg.result);
//           }
//         }
//       } catch {}
//     });
//
//     await Promise.race([
//       this.send("initialize", {
//         protocolVersion: "2024-11-05",
//         capabilities: {},
//         clientInfo: { name: "super-agent", version: "0.5.0" },
//       }),
//       new Promise((_, reject) =>
//         setTimeout(
//           () => reject(new Error("MCP initialize 超时（15s），进程可能未能启动")),
//           15000,
//         ),
//       ),
//     ]);
//
//     this.process?.stdin?.write(
//       JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
//         "\n",
//     );
//   }
//
//   private send(method: string, params?: any): Promise<any> {
//     return new Promise((resolve, reject) => {
//       const id = ++this.requestId;
//       const timer = setTimeout(() => {
//         this.pedding.delete(id);
//         reject(new Error(`MCP request timeout: ${method}`));
//       }, 150000);
//       this.pedding.set(id, {
//         resolve: (v: any) => { clearTimeout(timer); resolve(v); },
//         reject: (e: Error) => { clearTimeout(timer); reject(e); },
//       });
//       const msg = JSON.stringify({ id, method, params, jsonrpc: "2.0" });
//       this.process?.stdin?.write(msg + "\n");
//     });
//   }
//
//   async listTools(): Promise<MCPTool[]> {
//     const result = await this.send("tools/list", {});
//     return result.tools || [];
//   }
//
//   async callTool(name: string, args: Record<string, unknown>): Promise<string> {
//     const result: MCPCallResult = await this.send("tools/call", {
//       name,
//       arguments: args,
//     });
//     const texts = (result.content || [])
//       .filter((c) => c.type === "text" && c.text)
//       .map((c) => c.text!);
//     return texts.join("\n") || "(无返回内容)";
//   }
//
//   async close() {
//     this.rl?.close();
//     this.process?.kill();
//   }
// }

/**
 * 生产实现：基于 @modelcontextprotocol/sdk 的 stdio Client。
 * 对外暴露的接口（connect / listTools / callTool / close）与手写版保持一致，
 * 因此 ToolRegistry 无需任何改动。
 */
export class MCPClient {
  private client: Client;
  private transport: StdioClientTransport;
  private serverName: string;

  constructor(command: string, args: string[], env?: Record<string, string>) {
    this.serverName =
      args[args.length - 1]?.replace(/^@.*\//, "") || "mcp-server";

    this.transport = new StdioClientTransport({
      command,
      args,
      // SDK 要求显式传完整环境；把当前进程 env 与自定义 env 合并
      env: { ...process.env, ...env } as Record<string, string>,
      // 子进程 stderr 默认继承到父进程，便于排查起不来的真实原因
      stderr: "inherit",
    });

    this.client = new Client(
      { name: "super-agent", version: "0.5.0" },
      { capabilities: {} },
    );
  }

  async connect() {
    // connect() 内部完成了 spawn + initialize + notifications/initialized 握手
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.client.listTools();
    return (result.tools || []) as MCPTool[];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args });
    const content = (result.content || []) as Array<{
      type: string;
      text?: string;
    }>;
    const texts = content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text!);
    return texts.join("\n") || "(无返回内容)";
  }

  async close() {
    // close() 会同时关闭 transport 并终止子进程
    await this.client.close();
  }
}
