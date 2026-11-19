import type { ChangeSetStatus } from '@aiops/core';
import { ApplicationFailure } from '@temporalio/common';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type DataPoint,
  type Histogram,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import type { WorkerActivities } from '../activities/index.js';
import { CHANGESET_STATUSES, registerChangeSetGauge, timeBatchActivities } from './metrics.js';

describe('NFR-12 worker metrics', () => {
  let reader: PeriodicExportingMetricReader;
  let provider: MeterProvider;

  beforeEach(() => {
    reader = new PeriodicExportingMetricReader({
      exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
      // Collection is driven by reader.collect(); the interval only has to outlast the test.
      exportIntervalMillis: 3_600_000,
    });
    provider = new MeterProvider({ readers: [reader] });
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  async function metric(name: string): Promise<MetricData | undefined> {
    const { resourceMetrics } = await reader.collect();
    return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
  }

  async function gauge(): Promise<Record<string, number>> {
    const points = ((await metric('aiops_changesets'))?.dataPoints ?? []) as DataPoint<number>[];
    return Object.fromEntries(points.map((p) => [String(p.attributes.status), p.value]));
  }

  it('NFR-12 CHANGESET_STATUSES covers every ChangeSetStatus', () => {
    expectTypeOf<Exclude<ChangeSetStatus, (typeof CHANGESET_STATUSES)[number]>>().toEqualTypeOf<never>();
    expect(new Set(CHANGESET_STATUSES).size).toBe(CHANGESET_STATUSES.length);
  });

  it('NFR-12 aiops_changesets reports every status, 0 when absent', async () => {
    registerChangeSetGauge(provider.getMeter('t'), () => Promise.resolve(new Map([['prepared', 2], ['completed', 1]])));
    const values = await gauge();
    expect(Object.keys(values).sort()).toEqual([...CHANGESET_STATUSES].sort());
    expect(values.prepared).toBe(2);
    expect(values.completed).toBe(1);
    expect(values.failed).toBe(0);
  });

  it('NFR-12 counts are cached for 15 s', async () => {
    let calls = 0;
    let t = 0;
    registerChangeSetGauge(
      provider.getMeter('t'),
      () => {
        calls += 1;
        return Promise.resolve(new Map([['prepared', calls]]));
      },
      () => t,
    );
    await gauge();
    t = 10_000;
    expect((await gauge()).prepared).toBe(1);
    expect(calls).toBe(1);
    t = 16_000;
    expect((await gauge()).prepared).toBe(2);
    expect(calls).toBe(2);
  });

  it('NFR-12 a failing count query keeps the last values and does not throw', async () => {
    let fail = false;
    let t = 0;
    registerChangeSetGauge(
      provider.getMeter('t'),
      () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(new Map([['prepared', 3]]))),
      () => t,
    );
    expect((await gauge()).prepared).toBe(3);
    fail = true;
    t = 20_000;
    expect((await gauge()).prepared).toBe(3);
  });

  it('NFR-12 nothing is observed until the first count succeeds', async () => {
    let fail = true;
    let t = 0;
    registerChangeSetGauge(
      provider.getMeter('t'),
      () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(new Map([['prepared', 5]]))),
      () => t,
    );
    expect(await gauge()).toEqual({});
    fail = false;
    t = 1;
    expect((await gauge()).prepared).toBe(5);
  });

  it('NFR-12 a hanging count query keeps the last values and starts no second query', async () => {
    let calls = 0;
    let hang = false;
    let t = 0;
    registerChangeSetGauge(
      provider.getMeter('t'),
      () => {
        calls += 1;
        return hang ? new Promise<never>(() => undefined) : Promise.resolve(new Map([['prepared', 4]]));
      },
      () => t,
      // The deadline fires at once: no wall-clock wait.
      { deadline: (work) => (hang ? Promise.reject(new Error('deadline')) : work) },
    );
    expect((await gauge()).prepared).toBe(4);
    hang = true;
    t = 20_000;
    expect((await gauge()).prepared).toBe(4);
    expect(calls).toBe(2);
    t = 40_000;
    expect((await gauge()).prepared).toBe(4);
    expect(calls).toBe(2);
  });

  it('NFR-12 batch durations are recorded per phase and outcome', async () => {
    let t = 0;
    const superseded = ApplicationFailure.nonRetryable('batch_superseded');
    const writer = ApplicationFailure.retryable('writer_failed');
    const base = {
      executeBatch: (_id: string, batchNo: number) => {
        t += 1_000;
        return batchNo === 0 ? Promise.resolve({ ok: true }) : Promise.reject(superseded);
      },
      rollbackBatch: () => {
        t += 3_000;
        return Promise.reject(writer);
      },
      echo: (s: string) => Promise.resolve(s),
    } as unknown as WorkerActivities;
    const wrapped = timeBatchActivities(base, provider.getMeter('t'), () => t);

    await expect(wrapped.executeBatch('c', 0)).resolves.toEqual({ ok: true });
    await expect(wrapped.executeBatch('c', 1)).rejects.toBe(superseded);
    await expect(wrapped.rollbackBatch('c', 0)).rejects.toBe(writer);
    await expect(wrapped.echo('x')).resolves.toBe('x');

    const data = await metric('aiops_batch_duration_seconds');
    const points = (data?.dataPoints ?? []) as DataPoint<Histogram>[];
    const byLabel = Object.fromEntries(
      points.map((p) => [`${String(p.attributes.phase)}/${String(p.attributes.outcome)}`, p.value]),
    );
    expect(Object.keys(byLabel).sort()).toEqual(['execute/ok', 'execute/superseded', 'rollback/error']);
    expect(byLabel['execute/ok']?.sum).toBe(1);
    expect(byLabel['rollback/error']?.sum).toBe(3);
    expect(byLabel['rollback/error']?.buckets.boundaries).toEqual([0.5, 1, 2.5, 5, 10, 30, 60, 120, 300]);
  });
});
