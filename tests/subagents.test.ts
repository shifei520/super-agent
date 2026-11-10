import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { spawnAgent, spawnParallel, type SpawnContext } from '../src/subagents/spawn';
import { SubAgentRegistry } from '../src/subagents/registry';
import { ToolRegistry } from '../src/tools/tool-registry';
import { createSpawnTool } from '../src/tools/spawn-tools';
import { HookPipeline } from '../src/security/hooks';
import { agentLoop } from '../src/agent/loop';

const finish = (reason = 'stop') => ({
  type: 'finish', finishReason: { unified: reason, raw: reason },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
});
const answer = (text: string) => [
  { type: 'text-start', id: 'text' },
  { type: 'text-delta', id: 'text', delta: text },
  { type: 'text-end', id: 'text' }, finish(),
];
function modelFor(rounds: any[][]) {
  let index = 0;
  return new MockLanguageModelV3({ doStream: async () => ({
    stream: convertArrayToReadableStream(rounds[index++] ?? answer('unexpected repeat')),
  }) });
}
function context(model = modelFor([answer('final result')])): SpawnContext {
  return { model, toolRegistry: new ToolRegistry(), agentRegistry: new SubAgentRegistry(), buildSystem: () => 'test', currentDepth: 0 };
}
async function capture(run: () => Promise<void>) {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  try { await run(); } finally { console.log = original; }
  return logs.join('\n');
}

test('child executes tools and returns only its final answer without step logs', async () => {
  const model = modelFor([
    [{ type: 'tool-call', toolCallId: 'call', toolName: 'lookup', input: '{}' }, finish('tool-calls')],
    answer('private final answer'),
  ]);
  const ctx = context(model);
  let calls = 0;
  ctx.toolRegistry.register({ name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: {} }, execute: async () => { calls++; return 'private tool result'; } });
  const logs = await capture(async () => {
    assert.equal(await spawnAgent({ task: 'task' }, ctx), 'private final answer');
  });
  assert.equal(calls, 1);
  assert.equal(model.doStreamCalls.length, 2);
  assert.equal(ctx.agentRegistry.getAllRuns()[0].status, 'completed');
  assert.match(logs, /运行中/);
  assert.match(logs, /完成/);
  assert.doesNotMatch(logs, /Step|获取|调用|private/);
});

test('stream errors and timeout are not reported as successful completion', async () => {
  const ctx = context(modelFor([[{ type: 'error', error: new Error('stream failed') }]]));
  await capture(async () => assert.match(await spawnAgent({ task: 'task' }, ctx), /stream failed/));
  assert.equal(ctx.agentRegistry.getAllRuns()[0].status, 'error');
  const slow = context(new MockLanguageModelV3({ doStream: async ({ abortSignal }) => {
    await new Promise<void>((resolve, reject) => {
      abortSignal!.addEventListener('abort', () => reject(abortSignal!.reason), { once: true });
    });
    return { stream: convertArrayToReadableStream([]) };
  } }));
  slow.agentRegistry = new SubAgentRegistry({ defaultTimeout: 20 });
  await capture(async () => assert.match(await spawnAgent({ task: 'slow' }, slow), /超时/));
  assert.equal(slow.agentRegistry.getAllRuns()[0].status, 'timeout');
});

test('all entry points enforce depth and concurrency limits', async () => {
  const ctx = context();
  ctx.currentDepth = 1;
  assert.match(await spawnAgent({ task: 'task' }, ctx), /最大嵌套深度/);
  assert.equal(ctx.agentRegistry.getAllRuns().length, 0);
  ctx.currentDepth = 0;
  ctx.agentRegistry = new SubAgentRegistry({ maxConcurrency: 1 });
  await capture(async () => {
    const results = await spawnParallel([{ task: 'a' }, { task: 'b' }], ctx);
    assert.equal(results[0].result, 'final result');
    assert.match(results[1].result, /拒绝/);
  });
  assert.equal(ctx.agentRegistry.getAllRuns().length, 1);
});

test('quiet tools retain hooks and check commands after hook modification', async () => {
  const registry = new ToolRegistry();
  let executed = false;
  registry.register({ name: 'bash', description: 'bash', parameters: {}, execute: async () => { executed = true; return 'bad'; } });
  const hooks = new HookPipeline();
  hooks.registerPre('rewrite', () => ({ action: 'modify', modifiedInput: { command: 'rm -rf /' } }));
  registry.setHookPipeline(hooks);
  const logs = await capture(async () => {
    assert.match(await registry.toAISDKFormat({ quiet: true }).bash.execute({ command: 'pwd' }), /拒绝执行/);
  });
  assert.equal(executed, false);
  assert.equal(logs, '');
});

test('orchestration does not deadlock and tool results reach the main model without console echo', { timeout: 3000 }, async () => {
  const ctx = context(modelFor([
    [{ type: 'tool-call', toolCallId: 'lookup', toolName: 'lookup', input: '{}' }, finish('tool-calls')],
    answer('final result'),
  ]));
  ctx.toolRegistry.register({ name: 'lookup', description: '', parameters: { type: 'object', properties: {} }, execute: async () => 'data' });
  ctx.toolRegistry.register(createSpawnTool(() => ctx));
  const main = modelFor([
    [{ type: 'tool-call', toolCallId: 'spawn', toolName: 'spawn_agent', input: '{"task":"child"}' }, finish('tool-calls')],
    answer(''),
  ]);
  const messages: any[] = [{ role: 'user', content: 'delegate' }];
  const logs = await capture(async () => { await agentLoop(main, ctx.toolRegistry, messages, 'test'); });
  assert.ok(JSON.stringify(messages).includes('final result'));
  assert.doesNotMatch(logs, /final result/);
  assert.equal(ctx.agentRegistry.getAllRuns()[0].status, 'completed');
});

test('exclusive tools never overlap with queued shared tools', async () => {
  const registry = new ToolRegistry();
  let exclusive = false;
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  registry.register(
    { name: 'write', description: '', parameters: {}, execute: async () => {
      assert.equal(exclusive, false); exclusive = true; started(); await gate;
      await new Promise(resolve => setTimeout(resolve, 5)); exclusive = false; return 'ok';
    } },
    { name: 'read', description: '', parameters: {}, isConcurrencySafe: true, execute: async () => { assert.equal(exclusive, false); return 'ok'; } },
  );
  const tools = registry.toAISDKFormat({ quiet: true });
  const first = tools.write.execute({});
  await startedPromise;
  const second = tools.write.execute({});
  const reader = tools.read.execute({});
  release();
  await Promise.all([first, second, reader]);
});
