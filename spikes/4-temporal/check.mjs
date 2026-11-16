// Spike 4 checks. Expects the Temporal dev server (compose project fde-spike-4) on 127.0.0.1:4233.
// Workers are separate OS processes started and stopped here, so "deploy" = real process replacement.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';
import { Worker, Runtime, DefaultLogger } from '@temporalio/worker';
Runtime.install({ logger: new DefaultLogger('ERROR'), telemetryOptions: { logging: { filter: 'ERROR' } } });
import { historyToJSON } from '@temporalio/common/lib/proto-utils';

const ADDRESS = '127.0.0.1:4233';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const HIST = here('./histories');
rmSync(HIST, { recursive: true, force: true });
mkdirSync(HIST);

const results = [];
function record(name, ok, detail = '') {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${desc}`);
    await sleep(300);
  }
}

const connection = await Connection.connect({ address: ADDRESS });
const client = new Client({ connection });
const TQ = `spike4-${process.pid}-${Date.now()}`; // unique per run: a stray worker from an earlier run can never steal tasks
const live = new Set(); // worker processes, killed in the finally block

// ---- worker processes ----
function startWorker(variant, env = {}) {
  const proc = spawn(process.execPath, [here('./worker.mjs')], {
    env: { ...process.env, VARIANT: variant, TASK_QUEUE: TQ, TEMPORAL_ADDRESS: ADDRESS, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.add(proc);
  const exited = new Promise((res) => proc.on('exit', (c) => { live.delete(proc); res(c); }));
  let out = '';
  const ready = new Promise((res, rej) => {
    proc.stdout.on('data', (d) => { out += d; if (out.includes('READY')) res(); });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (c) => rej(new Error(`worker ${variant} exited ${c}: ${out.slice(-800)}`)));
  });
  return ready.then(() => ({
    variant, pid: proc.pid,
    async stop() {
      proc.kill('SIGTERM');
      const t = setTimeout(() => proc.kill('SIGKILL'), 20000);
      await exited; clearTimeout(t);
    },
  }));
}

// ---- history helpers ----
const hist = (id) => client.workflow.getHandle(id).fetchHistory();
const evs = (h) => h.events ?? [];
const activityCompleted = (h) => evs(h).filter((e) => e.activityTaskCompletedEventAttributes).length;
const activityScheduled = (h) => evs(h).filter((e) => e.activityTaskScheduledEventAttributes).length;
const wftCompleted = (h) => evs(h).filter((e) => e.workflowTaskCompletedEventAttributes).length;
const wftFailures = (h) => evs(h).filter((e) => e.workflowTaskFailedEventAttributes).map((e) => e.workflowTaskFailedEventAttributes);
const status = async (id) => (await client.workflow.getHandle(id).describe()).status.name;
const save = async (id, file) => writeFileSync(`${HIST}/${file}`, historyToJSON(await hist(id)));
const start = (type, id) => client.workflow.start(type, { taskQueue: TQ, workflowId: id, args: [id] });
const signal = (id) => client.workflow.getHandle(id).signal('approve');
const result = (id) => client.workflow.getHandle(id).result();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function replay(variant, file, wfId) {
  const history = JSON.parse((await import('node:fs')).readFileSync(`${HIST}/${file}`, 'utf8'));
  try {
    await Worker.runReplayHistory({ workflowsPath: here(`./workflows-${variant}.ts`) }, history, wfId);
    return { ok: true };
  } catch (e) {
    return { ok: false, det: e?.name === 'DeterminismViolationError', name: e?.name, msg: String(e?.message).split('\n')[0] };
  }
}

try {
  // =====================  PHASE 1: v1 worker  =====================
  let w = await startWorker('v1');
  console.log(`# phase 1: worker v1 pid=${w.pid}`);

  const wOp = 'cs-op-waits', wAfter = 'cs-op-after-wait', wDeploy = 'cs-op-deploy', wRestart = 'cs-op-restart', wDone = 'cs-op-complete';
  const gOld = 'cs-gated-old', gUnsafe = 'cs-gated-unsafe';
  for (const id of [wOp, wAfter, wDeploy, wRestart, wDone]) await start('operationWorkflow', id);
  for (const id of [gOld, gUnsafe]) await start('gatedWorkflow', id);

  // operationWorkflow: wait until the first workflow task completed (it is parked on the signal).
  for (const id of [wOp, wAfter, wDeploy, wRestart, wDone]) await waitFor(`${id} parked`, async () => wftCompleted(await hist(id)) >= 1);
  // gatedWorkflow: stepA ran before the wait; wait until A is completed and the follow-up task completed.
  for (const id of [gOld, gUnsafe]) await waitFor(`${id} A done and parked`, async () => {
    const h = await hist(id);
    return activityCompleted(h) === 1 && wftCompleted(h) >= 2;
  }).catch(async (e) => { const h = await hist(id); console.log('# DEBUG', id, evs(h).map((x) => x.eventType).join(',')); throw e; });

  {
    const h = await hist(wOp);
    const st = await status(wOp);
    record('v1-workflow-waits', st === 'RUNNING' && activityScheduled(h) === 0,
      `status=${st} activities_scheduled=${activityScheduled(h)} (operationWorkflow, parked on approve)`);
    const hg = await hist(gOld);
    console.log(`# gatedWorkflow parked: activities_scheduled=${activityScheduled(hg)} completed=${activityCompleted(hg)}`);
  }
  await save(wOp, 'op-v1-waiting.json');
  await save(gOld, 'gated-v1-waiting.json');
  // A completed v1 history (A,B,C all recorded) for replay tests.
  await signal(wDone);
  const doneResult = await result(wDone);
  console.log(`# v1 completed result: ${JSON.stringify(doneResult)}`);
  await save(wDone, 'op-v1-completed.json');
  const eventsBeforeRestart = evs(await hist(wRestart)).length;

  await w.stop();
  console.log('# worker v1 stopped (cache gone)');

  // =====================  PHASE 2: v2-unsafe (negative controls)  =====================
  w = await startWorker('v2-unsafe');
  console.log(`# phase 2: worker v2-unsafe pid=${w.pid}`);

  // 2a. Insertion AFTER the wait, waiting workflow has no activity commands recorded -> not detected.
  await signal(wAfter);
  let afterRes = null, afterErr = null;
  try { afterRes = await Promise.race([result(wAfter), sleep(40000).then(() => { throw new Error('timeout'); })]); } catch (e) { afterErr = e; }
  const afterFailures = wftFailures(await hist(wAfter));
  record('unsafe-change-after-wait-not-detected-for-waiting-workflow',
    !afterErr && afterRes?.length === 4 && afterFailures.length === 0,
    `result=${JSON.stringify(afterRes)} wft_failures=${afterFailures.length} (documents which change is SAFE without versioning)`);

  // 2b. Negative control: change lies in recorded history (stepA2 before recorded stepA).
  await signal(gUnsafe);
  const failed = await waitFor('nondeterminism WFT failure', async () => {
    const f = wftFailures(await hist(gUnsafe));
    return f.length ? f : null;
  }, 60000).catch(() => null);
  const failMsg = failed ? (failed[0].failure?.message ?? '') : '';
  const stillRunning = (await status(gUnsafe)) === 'RUNNING';
  record('unsafe-change-fails-nondeterminism',
    !!failed && /nondetermin|non-determin/i.test(failMsg + ' ' + failed[0].cause) && stillRunning,
    `cause=${failed?.[0].cause} status=${await status(gUnsafe)} msg="${failMsg.slice(0, 140)}"`);

  await w.stop();

  // 2c. The failure is a stuck workflow TASK, not a failed workflow: rolling back the code recovers it.
  w = await startWorker('v1');
  const recovered = await result(gUnsafe).catch((e) => `ERR ${e.message}`);
  record('rollback-to-v1-recovers-nondeterministic-workflow', same(recovered, ['A:' + gUnsafe, 'B:' + gUnsafe, 'C:' + gUnsafe]),
    `result=${JSON.stringify(recovered)}`);
  await w.stop();

  // =====================  PHASE 3: v2-patched  =====================
  w = await startWorker('v2-patched');
  console.log(`# phase 3: worker v2-patched pid=${w.pid}`);

  // old gated workflow (A already recorded without patch marker) -> old path
  await signal(gOld);
  const oldRes = await result(gOld);
  record('patched-old-workflow-completes-old-path', same(oldRes, ['A:' + gOld, 'B:' + gOld, 'C:' + gOld]),
    `result=${JSON.stringify(oldRes)} (3 outputs, no stepA2)`);

  // new gated workflow -> new path
  const gNew = 'cs-gated-new';
  await start('gatedWorkflow', gNew);
  await waitFor('gated-new parked', async () => { const h = await hist(gNew); return activityCompleted(h) === 2 && wftCompleted(h) >= 2; });
  await signal(gNew);
  const newRes = await result(gNew);
  record('patched-new-workflow-takes-new-path', same(newRes, ['A2:' + gNew, 'A:' + gNew, 'B:' + gNew, 'C:' + gNew]),
    `result=${JSON.stringify(newRes)} (4 outputs)`);

  // operationWorkflow started on v1 and waiting while v1 worker was replaced by v2-patched
  await signal(wDeploy);
  const depRes = await result(wDeploy);
  record('waiting-workflow-survives-deploy', same(depRes, ['A:' + wDeploy, 'A2:' + wDeploy, 'B:' + wDeploy, 'C:' + wDeploy]),
    `result=${JSON.stringify(depRes)} (started on v1, waited through process replacement; no history past the wait -> patched() is true live)`);
  await save(wDeploy, 'op-v2patched-completed.json');
  await save(gNew, 'gated-v2patched-completed.json');
  await w.stop();

  // =====================  PHASE 4: server restart =====================
  const stBefore = await status(wRestart);
  execFileSync('docker', ['compose', '-p', 'fde-spike-4', 'restart', 'temporal'], { stdio: 'ignore' });
  await waitFor('server ready after restart', async () => {
    try {
      execFileSync('docker', ['compose', '-p', 'fde-spike-4', 'exec', '-T', 'temporal', 'temporal', 'operator', 'cluster', 'health', '--address', '127.0.0.1:7233'], { stdio: 'ignore' });
      await client.workflow.getHandle(wRestart).describe();
      return true;
    } catch { return false; }
  }, 120000);
  const stAfter = await status(wRestart);
  const eventsAfter = evs(await hist(wRestart)).length;
  w = await startWorker('v2-patched');
  await signal(wRestart);
  const rr = await result(wRestart);
  record('server-restart-preserves-waiting-workflow',
    stBefore === 'RUNNING' && stAfter === 'RUNNING' && eventsAfter === eventsBeforeRestart && rr.length === 4,
    `status before/after=${stBefore}/${stAfter} history_events before/after=${eventsBeforeRestart}/${eventsAfter} result=${JSON.stringify(rr)}`);
  await w.stop();

  // =====================  PHASE 5: replay tests  =====================
  let r;
  r = await replay('v2-patched', 'op-v1-completed.json', 'x');
  record('replay-v1-history-against-v2-patched-ok', r.ok, r.ok ? 'completed v1 history (A,B,C) replays cleanly' : `${r.name}: ${r.msg}`);
  r = await replay('v2-unsafe', 'op-v1-completed.json', 'x');
  record('replay-v1-history-against-v2-unsafe-fails', !r.ok && r.det, r.ok ? 'replay unexpectedly succeeded' : `${r.name}: ${r.msg}`);
  r = await replay('v2-patched', 'gated-v1-waiting.json', 'x');
  record('replay-v1-gated-waiting-history-against-v2-patched-ok', r.ok, r.ok ? 'ok' : `${r.name}: ${r.msg}`);
  r = await replay('v2-unsafe', 'gated-v1-waiting.json', 'x');
  record('replay-v1-gated-waiting-history-against-v2-unsafe-fails', !r.ok && r.det, r.ok ? 'replay unexpectedly succeeded' : `${r.name}: ${r.msg}`);
  r = await replay('v2-unsafe', 'op-v1-waiting.json', 'x');
  record('replay-of-waiting-history-cannot-see-after-wait-change', r.ok,
    'v1 history parked at the wait replays cleanly against v2-unsafe: only a history recorded past the change can expose it');
  r = await replay('v2-patched', 'op-v2patched-completed.json', 'x');
  record('replay-v2-patched-history-against-v2-patched-ok', r.ok, r.ok ? 'history with patch marker replays' : `${r.name}: ${r.msg}`);
  r = await replay('v1', 'op-v2patched-completed.json', 'x');
  record('replay-v2-patched-history-against-v1-fails', !r.ok && r.det, r.ok ? 'unexpectedly ok' : `${r.name}: ${r.msg} (no downgrade after a patched run completed)`);
} catch (e) {
  for (const p of live) p.kill('SIGKILL');
  console.log(`FAIL check-harness  -- ${e.stack}`);
  results.push(['check-harness', false]);
}
for (const p of live) p.kill('SIGKILL');
await connection.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`# ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
