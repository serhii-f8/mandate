import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { streamTo } from './export.controller.js';

async function* chunks(...values: (string | Error)[]): AsyncGenerator<string> {
  for (const value of values) {
    await Promise.resolve();
    if (value instanceof Error) throw value;
    yield value;
  }
}

async function collect(stream: PassThrough): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += String(chunk);
  return text;
}

describe('streamTo', () => {
  it('CS-8 streamTo ends the response after the last chunk', async () => {
    const res = new PassThrough();
    const errors: unknown[] = [];
    res.on('error', (e) => errors.push(e));
    const finished = new Promise<void>((resolve) => res.once('finish', resolve));
    const body = collect(res);
    await streamTo(res, chunks('a', 'b', 'c'));
    expect(await body).toBe('abc');
    await finished;
    expect(res.writableEnded).toBe(true);
    expect(errors).toEqual([]);
  });

  it('CS-8 streamTo waits for drain when the response buffer is full', async () => {
    const res = new PassThrough({ highWaterMark: 4 });
    const big = 'x'.repeat(64);
    const done = streamTo(res, chunks(big, big, big));
    // Nothing reads yet: the writer must be waiting on 'drain', not finished.
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.writableEnded).toBe(false);
    expect(await collect(res)).toBe(big.repeat(3));
    await done;
    expect(res.writableEnded).toBe(true);
  });

  it('CS-8 an error after the first chunk destroys the response instead of ending it', async () => {
    const res = new PassThrough();
    let finished = false;
    res.on('finish', () => {
      finished = true;
    });
    const errors: unknown[] = [];
    res.on('error', (e) => errors.push(e));
    res.resume();
    const failure = new Error('page read failed');
    await expect(streamTo(res, chunks('first', failure))).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(res.destroyed).toBe(true);
    expect(finished).toBe(false);
    expect(errors).toEqual([failure]);
  });

  it('NFR-7 a response the client closes stops reading further pages', async () => {
    const res = new PassThrough({ highWaterMark: 4 });
    let produced = 0;
    let closed = false;
    async function* endless(): AsyncGenerator<string> {
      try {
        for (;;) {
          produced += 1;
          await Promise.resolve();
          yield 'x'.repeat(64);
        }
      } finally {
        closed = true;
      }
    }
    const done = streamTo(res, endless());
    await new Promise((resolve) => setImmediate(resolve));
    res.destroy();
    await done;
    expect(produced).toBe(1);
    expect(closed).toBe(true);
  });
});
