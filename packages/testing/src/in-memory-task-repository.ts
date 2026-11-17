import { isTaskId, type TaskRecord, type TaskRepository } from '@aiops/core';

/** In-memory task store keyed by task ID. */
export class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, TaskRecord>();

  create(task: TaskRecord): Promise<void> {
    if (this.tasks.has(task.taskId)) return Promise.reject(new Error(`duplicate task ${task.taskId}`));
    this.tasks.set(task.taskId, task);
    return Promise.resolve();
  }

  findOwned(taskId: string, owner: string): Promise<TaskRecord | undefined> {
    if (!isTaskId(taskId)) return Promise.resolve(undefined);
    const task = this.tasks.get(taskId);
    return Promise.resolve(task?.owner === owner ? task : undefined);
  }
}
