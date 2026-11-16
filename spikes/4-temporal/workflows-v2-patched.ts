import { proxyActivities, defineSignal, setHandler, condition, patched } from '@temporalio/workflow';

const acts = proxyActivities<{
  stepA(id: string): Promise<string>;
  stepA2(id: string): Promise<string>;
  stepB(id: string): Promise<string>;
  stepC(id: string): Promise<string>;
}>({ startToCloseTimeout: '30 seconds' });

export const approve = defineSignal('approve');

/** Same change as v2-unsafe, guarded by patched(). */
export async function operationWorkflow(changesetId: string): Promise<string[]> {
  let approved = false;
  setHandler(approve, () => { approved = true; });
  await condition(() => approved);
  const out: string[] = [];
  out.push(await acts.stepA(changesetId));
  if (patched('opwf-add-stepA2')) {
    out.push(await acts.stepA2(changesetId));
  }
  out.push(await acts.stepB(changesetId));
  out.push(await acts.stepC(changesetId));
  return out;
}

/** Same change as v2-unsafe gated, guarded by patched(). */
export async function gatedWorkflow(changesetId: string): Promise<string[]> {
  let approved = false;
  setHandler(approve, () => { approved = true; });
  const out: string[] = [];
  if (patched('gated-add-stepA2-first')) {
    out.push(await acts.stepA2(changesetId));
  }
  out.push(await acts.stepA(changesetId));
  await condition(() => approved);
  out.push(await acts.stepB(changesetId));
  out.push(await acts.stepC(changesetId));
  return out;
}
