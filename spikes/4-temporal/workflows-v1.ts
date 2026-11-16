import { proxyActivities, defineSignal, setHandler, condition } from '@temporalio/workflow';

const acts = proxyActivities<{
  stepA(id: string): Promise<string>;
  stepB(id: string): Promise<string>;
  stepC(id: string): Promise<string>;
}>({ startToCloseTimeout: '30 seconds' });

export const approve = defineSignal('approve');

/** Spec workflow: waits for the approval signal, then A, B, C. */
export async function operationWorkflow(changesetId: string): Promise<string[]> {
  let approved = false;
  setHandler(approve, () => { approved = true; });
  await condition(() => approved);
  const a = await acts.stepA(changesetId);
  const b = await acts.stepB(changesetId);
  const c = await acts.stepC(changesetId);
  return [a, b, c];
}

/** Control workflow: stepA runs BEFORE the wait, so a command is already in recorded history. */
export async function gatedWorkflow(changesetId: string): Promise<string[]> {
  let approved = false;
  setHandler(approve, () => { approved = true; });
  const a = await acts.stepA(changesetId);
  await condition(() => approved);
  const b = await acts.stepB(changesetId);
  const c = await acts.stepC(changesetId);
  return [a, b, c];
}
