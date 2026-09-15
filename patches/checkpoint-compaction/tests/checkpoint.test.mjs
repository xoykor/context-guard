import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { applyPatch } from '../apply-checkpoint-compaction.mjs';
const here = dirname(fileURLToPath(import.meta.url));
const installed = process.env.DSH_COMPACTION_TEST_TARGET ?? '/home/x/.local/lib/dsh-runtime-0.1.5-rc.2/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js';
const require = createRequire(installed);
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const { Session } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')));
const { TokenMeter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-token-meter')));
const { createUserMessage, createAssistantMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
const temp = mkdtempSync(join(tmpdir(), 'dsh-checkpoint-test-'));
let modules = dirname(installed);
while (!modules.endsWith('/node_modules') && dirname(modules) !== modules) modules = dirname(modules);
symlinkSync(modules, join(temp, 'node_modules'), 'dir');
writeFileSync(join(temp, 'engine.mjs'), readFileSync(join(here, '../lib/index.js')));
const { BasicCompactionEngine } = await import(pathToFileURL(join(temp, 'engine.mjs')));
const repoGuard = join(here, '../../../../dsh/plugins/dsh-context-guard/lib/index.js');
const guardFile = process.env.DSH_GUARD_TEST_TARGET ?? (existsSync(repoGuard) ? repoGuard : join(here, '../../guard/lib/index.js'));
const { apply: applyGuard } = await import(pathToFileURL(guardFile));
after(() => rmSync(temp, { recursive: true, force: true }));
const qwen = { contextWindow: 64000, summaryMaxTokens: 4000, summaryMinTokens: 500, safetyTokens: 2000 };
const ornith = { contextWindow: 131072, summaryMaxTokens: 8192, summaryMinTokens: 1024, safetyTokens: 4096 };
function harness(options = {}) {
  const ctx = new Context(); ctx.provide('sessionProjections', { register() {} });
  new TokenMeter(ctx);
  const session = new Session('checkpoint-test');
  const appendUser = text => session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('request/header', { header: { config: { provider: 'lmstudio', model: options.model ?? 'qwen3.8-27b-gsq-rco' } } });
  appendUser('Implement the authorized changes. ' + 'Older confirmed evidence. '.repeat(1200));
  appendUser('LATEST STATE: job bash-4 running; log /tmp/download.log; next collect job_output; do not duplicate.');
  const oldSurface = [...session.surface.nodes];
  const calls = []; const flushes = []; const phases = [];
  ctx.provide('sessions', { async flush(s) {
    flushes.push({ nodes: [...s.surface.nodes], events: s.snapshotEvents() });
    if (options.flushError) throw Error('disk unavailable');
    if (flushes.length === 1) await options.afterSave?.(s, appendUser);
  } });
  ctx.provide('llm', {
    imageRequestPricing() { return undefined; },
    async resolveModelInfo() { return { context: { contextWindow: options.capacity ?? 64000 } }; },
    async *stream(call) {
      calls.push(call); await options.beforeOutput?.(call);
      call.signal?.throwIfAborted();
      if (options.toolCall) yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'evil', name: 'bash', arguments: { command: 'echo unsafe' } } };
      else yield { type: 'text-delta', index: 0, text: options.empty ? '' : 'Current work: job bash-4 remains running. Next: collect /tmp/download.log; do not restart.' };
      yield { type: 'finish', reason: { kind: options.truncated ? 'max-tokens' : 'stop' } };
    },
  });
  const engine = new BasicCompactionEngine(ctx, { auto: false, maxTokens: 16384 });
  const agent = { session, options: {}, runMaintenance: task => task(new AbortController().signal) };
  const run = (budget = qwen, signal = new AbortController().signal) => engine.checkpointNow(agent, signal, { ...budget, onPhase: phase => phases.push(phase) });
  return { ctx, session, engine, agent, run, calls, flushes, phases, oldSurface, appendUser };
}

test('summarizes latest state with the same model, persists before replacement, then commits once', async () => {
  const h = harness(); const result = await h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].model, 'qwen3.8-27b-gsq-rco');
  assert.match(JSON.stringify(h.calls[0].messages), /LATEST STATE: job bash-4/);
  assert.equal(h.calls[0].maxTokens, 4000);
  assert.deepEqual(h.phases, ['summarizing', 'compacting']);
  assert.equal(h.flushes.length, 2);
  assert.deepEqual(h.flushes[0].nodes, h.oldSurface);
  assert.equal(h.flushes[0].events.at(-1).type, 'compaction/summary');
  assert.equal(h.session.surface.nodes.length, 1);
  assert.equal(h.session.eventAt(result.summarySeq).data.maxTokens, 4000);
  assert.equal(h.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 1);
  assert.match(JSON.stringify(h.session.deriveMessages()), /bash-4/);
});

test('Ornith retains its own model, 131072 context and 8192 output reserve', async () => {
  const h = harness({ model: 'ornith-1.5-9b', capacity: 131072 }); await h.run(ornith);
  assert.equal(h.calls[0].model, 'ornith-1.5-9b'); assert.equal(h.calls[0].maxTokens, 8192);
});

test('late context growth reduces the summary cap while including instructions and margin', async () => {
  const h = harness(); const measure = h.ctx.tokenMeter.measure.bind(h.ctx.tokenMeter);
  h.ctx.tokenMeter.measure = s => ({ ...measure(s), totalTokens: 60500 });
  await h.run();
  assert.ok(h.calls[0].maxTokens >= 500 && h.calls[0].maxTokens < 1500);
  const instruction = h.ctx.tokenMeter.estimateMessage(h.calls[0].messages.at(-1));
  assert.ok(60500 + instruction + h.calls[0].maxTokens + 2000 < 64000);
});

test('insufficient headroom never dispatches an overflowing request or changes the surface', async () => {
  const h = harness({ capacity: 6000 });
  await assert.rejects(h.run(), error => /insufficient context headroom/.test(error.cause?.message)); assert.equal(h.calls.length, 0);
  assert.deepEqual(h.session.surface.nodes, h.oldSurface);
});

for (const options of [{ truncated: true }, { empty: true }, { toolCall: true }, { flushError: true }]) {
  test(`failed checkpoint preserves original history: ${JSON.stringify(options)}`, async () => {
    const h = harness(options); await assert.rejects(h.run());
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.session.surface.nodes, h.oldSurface);
    assert.equal(h.session.snapshotEvents().at(-1).type, 'compaction/end');
  });
}

test('cancellation after summary persistence prevents replacement and keeps saved evidence', async () => {
  const abort = new AbortController(); const h = harness({ afterSave() { abort.abort(); } });
  await assert.rejects(h.run(qwen, abort.signal));
  assert.deepEqual(h.session.surface.nodes, h.oldSurface);
  assert.equal(h.session.snapshotEvents().filter(e => e.type === 'compaction/summary').length, 1);
});

test('new input arriving during persistence survives as uncompacted tail', async () => {
  const h = harness({ afterSave(s, append) { append('New instruction while checkpoint was saving'); } });
  await h.run(); assert.equal(h.session.surface.nodes.length, 2);
  assert.match(JSON.stringify(h.session.deriveMessages()), /New instruction/);
});

test('guard ownership bypasses native automatic pruning and compaction', async () => {
  const h = harness(); h.agent[Symbol.for('dsh.contextGuard.checkpointPolicy.v1')] = qwen;
  for (const trigger of ['pressure', 'context-overflow']) assert.equal(await h.engine.compactIfNeeded(h.agent, trigger, new AbortController().signal), null);
  assert.equal(h.calls.length, 0); assert.deepEqual(h.session.surface.nodes, h.oldSurface);
});

test('real guard + engine preserve claimed new input, await persistence, resume once without renewing call budgets', async () => {
  let release; const saved = new Promise(resolve => { release = resolve; });
  const h = harness({ afterSave: () => saved });
  let guard; h.ctx.provide('tools', { guard: fn => { guard = fn; } });
  const policy = { economyTokens: 32000, checkpointTokens: 40000, compactTokens: 44800,
    maxTurnMs: null, responseMaxTokens: 12000, maxTurnToolCalls: 5, ...qwen };
  h.agent.id = 'real-guard'; h.agent.ctx = h.ctx; h.agent.status = 'running';
  const cancelled = []; const steered = [];
  h.agent.cancel = reason => cancelled.push(reason);
  h.agent.steer = message => steered.push(message);
  applyGuard(h.ctx, policy);
  try {
    // Ownership works before stateFor/pre-step runs (native hook may run first).
    assert.equal(await h.engine.compactIfNeeded(h.agent, 'pressure', new AbortController().signal), null);
    const pre = (turn, messages = []) => h.ctx.waterfall('agent/pre-step', { agent: h.agent, turn, step: 1, messages, signal: new AbortController().signal }, async () => ({ messages }));
    await pre(1);
    for (let i = 0; i < 4; i++) assert.equal(guard({ agent: h.agent, name: 'bash', arguments: { command: `echo ${i}` } }), undefined);
    const measured = h.ctx.tokenMeter.measure.bind(h.ctx.tokenMeter);
    h.ctx.tokenMeter.measure = session => ({ ...measured(session), totalTokens: session.surface.replaceGeneration ? measured(session).totalTokens : 44800 });
    const claimed = createUserMessage({ source: { kind: 'plugin', plugin: 'job-notification' }, content: [{ type: 'text', text: 'Just arrived: job bash-9 completed; collect its existing artifact.' }] });
    assert.equal((await pre(2, [claimed])).kind, 'reject');
    assert.equal(cancelled.length, 1); assert.equal(h.calls.length, 0);
    assert.match(JSON.stringify(h.session.deriveMessages()), /job bash-9 completed/);
    h.agent.status = 'idle'; h.ctx.emit('agent/status', { agent: h.agent, status: 'idle' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 1);
    assert.match(JSON.stringify(h.calls[0].messages), /job bash-9 completed/);
    assert.equal(steered.length, 0);
    assert.match(guard({ agent: h.agent, name: 'bash', arguments: {} }), /summarization/);
    await h.ctx.waterfall('tools/post-execute', { agent: h.agent, name: 'bash', arguments: {} }, { isError: true, value: { timedOut: true } }, async () => undefined);
    assert.match(guard({ agent: h.agent, name: 'bash', arguments: {} }), /summarization/);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(steered.length, 1);
    h.ctx.emit('agent/status', { agent: h.agent, status: 'idle' });
    await pre(3, steered);
    assert.equal(h.calls.length, 1);
    assert.equal(guard({ agent: h.agent, name: 'bash', arguments: { command: 'last allowance' } }), undefined);
    assert.match(guard({ agent: h.agent, name: 'bash', arguments: { command: 'over budget' } }), /tool-call budget/);
  } finally { release(); h.ctx.emit('agent/disposed', { agent: h.agent }); }
});

test('runtime installer verifies hashes, backs up once and refuses external edits', () => {
  const manifest = JSON.parse(readFileSync(join(here, '../manifest.json')));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  let base = readFileSync(installed);
  if (hash(base) === manifest.patchedSha256) base = readFileSync(`${installed}.before-checkpoint-compaction-${manifest.baseSha256.slice(0, 12)}`);
  assert.equal(hash(base), manifest.baseSha256);
  const target = join(temp, 'fixture.mjs'); writeFileSync(target, base);
  assert.equal(applyPatch({ target, check: true }).status, 'unpatched');
  const first = applyPatch({ target }); assert.equal(first.changed, true);
  assert.deepEqual(readFileSync(first.backup), base);
  assert.equal(applyPatch({ target }).changed, false);
  assert.equal(applyPatch({ target, check: true }).status, 'patched');
  writeFileSync(target, '// external change');
  assert.throws(() => applyPatch({ target }), /Unsupported runtime content/);
});
