/**
 * Phase 1 smoke check through the payload codec (SEC-4):
 *   node dist/smoke-cli.js <message>
 * Starts `smokeWorkflow` on the worker's task queue with the encrypting client data converter and
 * prints its result, `{"echoed":"<message>"}`. Runs inside the worker container, whose environment
 * it parses as a whole (`parseWorkerEnv`); it uses only the Temporal address, namespace, task queue
 * and payload keys. Exit 0 on a completed workflow, 1 on failure, 2 on usage.
 */
import { randomUUID } from 'node:crypto';
import { parseWorkerEnv } from '@aiops/config';
import { clientDataConverter, parseTemporalKeys } from '@aiops/temporal';
import { Client, Connection } from '@temporalio/client';
import type { smokeWorkflow } from './workflows/smoke.js';

async function main(argv: readonly string[]): Promise<number> {
  const [message, ...rest] = argv;
  if (message === undefined || rest.length > 0) {
    console.error('usage: smoke-cli <message>');
    return 2;
  }
  const env = parseWorkerEnv(process.env);
  const connection = await Connection.connect({ address: env.temporalAddress });
  try {
    const client = new Client({
      connection,
      namespace: env.temporalNamespace,
      dataConverter: clientDataConverter(parseTemporalKeys(env.temporalKeys)),
    });
    const result = await client.workflow.execute<typeof smokeWorkflow>('smokeWorkflow', {
      args: [{ message }],
      taskQueue: env.taskQueue,
      workflowId: `smoke-${randomUUID()}`,
      workflowExecutionTimeout: '1 minute',
    });
    console.log(JSON.stringify(result));
    return 0;
  } finally {
    await connection.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // EnvError and key-parse messages carry variable names and indexes only, never values.
    console.error(JSON.stringify({ level: 'fatal', msg: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  },
);
