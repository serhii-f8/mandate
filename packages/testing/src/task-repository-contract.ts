import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TaskRecord, TaskRepository } from '@aiops/core';

/** `changesetId` yields an ID the store accepts as a change-set reference (a real row for PostgreSQL). */
export interface TaskRepositoryHarness {
  readonly tasks: TaskRepository;
  readonly changesetId: () => Promise<string>;
}

/** Behavior every TaskRepository implementation must have. */
export function describeTaskRepositoryContract(label: string, setup: () => Promise<TaskRepositoryHarness>): void {
  describe(`${label} NFR-3 SEC-1 task repository`, () => {
    const record = async (h: TaskRepositoryHarness, owner: string): Promise<TaskRecord> => ({
      taskId: randomUUID(),
      owner,
      clientId: 'client-1',
      changesetId: await h.changesetId(),
      kind: 'prepare',
      tool: 'catalog.update_content',
      createdAt: new Date('2026-11-17T10:00:00.123Z'),
      ttlMs: 604_800_000,
    });

    it('findOwned returns the created task for its owner', async () => {
      const h = await setup();
      const task = await record(h, 'alice');
      await h.tasks.create(task);
      const found = await h.tasks.findOwned(task.taskId, 'alice');
      expect(found).toEqual(task);
      expect(found?.createdAt.getTime()).toBe(task.createdAt.getTime());
    });

    it('findOwned is undefined for another owner', async () => {
      const h = await setup();
      const task = await record(h, 'alice');
      await h.tasks.create(task);
      expect(await h.tasks.findOwned(task.taskId, 'bob')).toBeUndefined();
    });

    it('findOwned is undefined for an unknown UUID', async () => {
      const h = await setup();
      expect(await h.tasks.findOwned(randomUUID(), 'alice')).toBeUndefined();
    });

    it('findOwned is undefined for a non-UUID id without throwing', async () => {
      const h = await setup();
      expect(await h.tasks.findOwned('x', 'alice')).toBeUndefined();
      expect(await h.tasks.findOwned('x'.repeat(5000), 'alice')).toBeUndefined();
    });

    it('create rejects a duplicate taskId', async () => {
      const h = await setup();
      const task = await record(h, 'alice');
      await h.tasks.create(task);
      await expect(h.tasks.create(task)).rejects.toThrow();
    });
  });
}
