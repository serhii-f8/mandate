import { proxyActivities, defineSignal, setHandler, condition } from '@temporalio/workflow';

const acts = proxyActivities<{
  stepA(id: string): Promise<string>;
  stepA2(id: string): Promise<string>;
  stepB(id: string): Promise<string>;
  stepC(id: string): Promise<string>;
}>({ startToCloseTimeout: '30 seconds' });

export const approve = defineSignal('approve');

/** UNSAFE: stepA2 inserted between A and B, no versioning. Lies after the wait. */
export async function operationWorkflow(changesetId: string): Promise<string[]> {
  let approved = false;
  setHandler(approve, () => { approved = true; });
  await condition(() => approved);
  const a = await acts.stepA(changesetId);
  const a2 = await acts.stepA2(changesetId);
  const b = await acts.stepB(changesetId);
  const c = await acts.stepC(changesetId);
  return [a, a2, b, c];
}

/** UNSAFE: stepA2 inserted BEFORE stepA, i.e. in history that is already recorded. */
export async function gatedWorkflow(changesetId: string): Promise<string[]> {
  let approved = false;
  setHandler(approve, () => { approved = true; });
  const a2 = await acts.stepA2(changesetId);
  const a = await acts.stepA(changesetId);
  await condition(() => approved);
  const b = await acts.stepB(changesetId);
  const c = await acts.stepC(changesetId);
  return [a2, a, b, c];
}
