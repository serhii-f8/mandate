// Spike 4, Step 6: Worker Versioning / Worker Deployments (PINNED) as an alternative to patched().
// Two worker builds poll one task queue side by side: build "b1" runs workflows-v1, build "b2" runs workflows-v2-unsafe
// (the unpatched, incompatible change). Pinned workflows must stay on b1 and never see b2's code.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client, Connection } from '@temporalio/client';

const ADDRESS = '127.0.0.1:4233';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const TQ = `spike4-wv-${process.pid}-${Date.now()}`;
const DEP = 'spike4-dep';
const results = [];
const record = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(desc, fn, timeoutMs = 90000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for: ${desc}`);
    await sleep(500);
  }
}
const cli = (...args) => execFileSync('docker', ['compose', '-p', 'fde-spike-4', 'exec', '-T', 'temporal', 'temporal', ...args, '--address', '127.0.0.1:7233'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const live = new Set();
function startWorker(variant, buildId) {
  const proc = spawn(process.execPath, [here('./worker.mjs')], {
    env: { ...process.env, VARIANT: variant, TASK_QUEUE: TQ, TEMPORAL_ADDRESS: ADDRESS, BUILD_ID: buildId, BEHAVIOR: 'PINNED' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.add(proc);
  const exited = new Promise((res) => proc.on('exit', (c) => { live.delete(proc); res(c); }));
  let out = '';
  return new Promise((res, rej) => {
    proc.stdout.on('data', (d) => { out += d; if (out.includes('READY')) res({ async stop() { proc.kill('SIGTERM'); const t = setTimeout(() => proc.kill('SIGKILL'), 20000); await exited; clearTimeout(t); } }); });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (c) => rej(new Error(`worker exited ${c}: ${out.slice(-600)}`)));
  });
}

const connection = await Connection.connect({ address: ADDRESS });
const client = new Client({ connection });
const hist = (id) => client.workflow.getHandle(id).fetchHistory();
const start = (type, id) => client.workflow.start(type, { taskQueue: TQ, workflowId: id, args: [id] });
const signal = (id) => client.workflow.getHandle(id).signal('approve');
const result = (id) => client.workflow.getHandle(id).result();
const wftDone = async (id) => (await hist(id)).events.filter((e) => e.workflowTaskCompletedEventAttributes);
const builds = async (id) => (await wftDone(id)).map((e) => {
  const a = e.workflowTaskCompletedEventAttributes;
  return a.workerDeploymentVersion?.buildId || a.deployment?.buildId || a.workerVersion?.buildId || '?';
});
const parkedWithA = (id) => async () => { const h = await hist(id); return h.events.filter((e) => e.activityTaskCompletedEventAttributes).length === 1 && h.events.filter((e) => e.workflowTaskCompletedEventAttributes).length >= 2; };
const setCurrent = (buildId) => waitFor(`set-current ${buildId}`, () => cli('worker', 'deployment', 'set-current-version', '--deployment-name', DEP, '--build-id', buildId, '--yes'));

try {
  const b1 = await startWorker('v1', 'b1');
  await setCurrent('b1');
  console.log('# build b1 (workflows-v1) is Current');

  // Pinned workflows started while b1 is current; gated ones have stepA recorded, the strongest replay hazard.
  await start('gatedWorkflow', 'wv-pinned'); await start('gatedWorkflow', 'wv-stranded');
  await waitFor('parked', parkedWithA('wv-pinned')); await waitFor('parked', parkedWithA('wv-stranded'));

  const b2 = await startWorker('v2-unsafe', 'b2');
  await setCurrent('b2');
  console.log('# build b2 (workflows-v2-unsafe, no patching) is now Current; b1 still polling');

  // 1. pinned workflow: signalled after b2 became current; must complete on b1 with the OLD result
  await signal('wv-pinned');
  const pinned = await Promise.race([result('wv-pinned'), sleep(60000).then(() => 'TIMEOUT')]);
  const pb = await builds('wv-pinned');
  record('worker-versioning-pinned-workflow-completes-on-old-build',
    JSON.stringify(pinned) === JSON.stringify(['A:wv-pinned', 'B:wv-pinned', 'C:wv-pinned']) && pb.every((b) => b === 'b1'),
    `result=${JSON.stringify(pinned)} builds_per_workflow_task=${pb.join(',')}`);

  // 2. new workflow goes to b2 (new code, unpatched change is fine because no old history exists)
  await start('gatedWorkflow', 'wv-new');
  await waitFor('new parked', async () => (await hist('wv-new')).events.filter((e) => e.activityTaskCompletedEventAttributes).length === 2 && (await wftDone('wv-new')).length >= 3);
  await signal('wv-new');
  const nres = await result('wv-new');
  const nb = await builds('wv-new');
  record('worker-versioning-new-workflow-runs-on-new-build',
    JSON.stringify(nres) === JSON.stringify(['A2:wv-new', 'A:wv-new', 'B:wv-new', 'C:wv-new']) && nb.every((b) => b === 'b2'),
    `result=${JSON.stringify(nres)} builds_per_workflow_task=${nb.join(',')}`);

  // 3. cost: a pinned workflow cannot progress once its build's workers are gone
  await b1.stop();
  await signal('wv-stranded');
  await sleep(15000);
  const st = (await client.workflow.getHandle('wv-stranded').describe()).status.name;
  const sdone = (await hist('wv-stranded')).events.filter((e) => e.workflowExecutionCompletedEventAttributes).length;
  record('worker-versioning-pinned-workflow-stranded-without-its-build', st === 'RUNNING' && sdone === 0,
    `after stopping b1 and signalling: status=${st} (the old build must keep running until pinned workflows drain)`);
  const b1again = await startWorker('v1', 'b1');
  const srec = await Promise.race([result('wv-stranded'), sleep(60000).then(() => 'TIMEOUT')]);
  record('worker-versioning-pinned-workflow-resumes-when-build-returns',
    JSON.stringify(srec) === JSON.stringify(['A:wv-stranded', 'B:wv-stranded', 'C:wv-stranded']), `result=${JSON.stringify(srec)}`);
  await b1again.stop(); await b2.stop();
  console.log('# `temporal worker deployment describe`:\n' + cli('worker', 'deployment', 'describe', '--name', DEP).split('\n').map((l) => '#   ' + l).join('\n'));
} catch (e) {
  for (const p of live) p.kill('SIGKILL');
  console.log(`FAIL worker-versioning-harness  -- ${e.stack}`);
  results.push(false);
}
for (const p of live) p.kill('SIGKILL');
await connection.close();
process.exit(results.every(Boolean) ? 0 : 1);
