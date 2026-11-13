import "dotenv/config";

const [command, ...rest] = process.argv.slice(2);

function printHelp() {
  console.log(`Super Agent

用法:
  pnpm start                 启动交互式 Agent
  pnpm run config:init       生成 / 重新生成 super-agent.config.json
  pnpm continue              恢复上次会话
  pnpm start --continue      同上
  pnpm start --help          显示本帮助

配置文件:
  super-agent.config.json    可用环境变量 SUPER_AGENT_CONFIG 指定其它路径
`);
}

async function main() {
  if (command === "init") {
    const { runInit } = await import("./config/init.js");
    await runInit();
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  const { startAgent } = await import("./main.js");
  await startAgent(rest);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n✗ ${message}`);
  process.exitCode = 1;
});
