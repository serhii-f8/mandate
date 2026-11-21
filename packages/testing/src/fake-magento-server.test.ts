// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeMagentoServer } from './fake-magento-server.js';

interface State {
  skus: Record<string, { submissions: number; applied: number; meta_keyword: unknown }>;
  bulks: { submitted: number; applied: number; open: number };
}

describe('NFR-1 fake Magento server', () => {
  let server: { url: string; close(): Promise<void> } | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const start = async (control = true): Promise<string> => {
    server = await startFakeMagentoServer({ host: '127.0.0.1', port: 0, products: 3, control });
    return server.url;
  };
  const send = (url: string, path: string, method = 'GET', body?: unknown): Promise<Response> =>
    fetch(`${url}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  const state = async (url: string): Promise<State> => (await (await send(url, '/_control/state')).json()) as State;
  const submit = async (url: string, skus: string[]): Promise<string> => {
    const r = await send(
      url,
      '/rest/all/async/bulk/V1/products',
      'POST',
      skus.map((sku) => ({ product: { sku, status: 1, custom_attributes: [{ attribute_code: 'meta_keyword', value: 'after' }] } })),
    );
    expect(r.status).toBe(202);
    return ((await r.json()) as { bulk_uuid: string }).bulk_uuid;
  };
  const poll = async (url: string, id: string): Promise<number[]> => {
    const r = await send(url, `/rest/all/V1/bulk/${id}/detailed-status`);
    return ((await r.json()) as { operations_list: { status: number }[] }).operations_list.map((o) => o.status);
  };

  it('serves product reads and the async bulk API of the catalog fake', async () => {
    const url = await start();
    const read = await send(url, '/rest/all/V1/products?searchCriteria[filter_groups][0][filters][0][field]=sku&searchCriteria[filter_groups][0][filters][0][value]=RST-0001&searchCriteria[filter_groups][0][filters][0][condition_type]=eq');
    const body = (await read.json()) as { items: { sku: string; status: number }[]; total_count: number };
    expect(body.total_count).toBe(1);
    expect(body.items[0]).toMatchObject({ sku: 'RST-0001', status: 1 });

    const id = await submit(url, ['RST-0001', 'RST-0002']);
    for (let i = 0; i < 20 && (await poll(url, id)).includes(4); i += 1) {
      // poll until the bulk completes
    }
    const s = await state(url);
    expect(s.skus['RST-0001']).toEqual({ submissions: 1, applied: 1, meta_keyword: 'after' });
    expect(s.skus['RST-0002']).toEqual({ submissions: 1, applied: 1, meta_keyword: 'after' });
    expect(s.skus['RST-0003']).toEqual({ submissions: 0, applied: 0, meta_keyword: 'seed' });
    expect(s.bulks).toEqual({ submitted: 1, applied: 1, open: 0 });
  });

  it('open-polls keeps a bulk open for n status polls', async () => {
    const url = await start();
    expect((await send(url, '/_control/open-polls', 'POST', { n: 3 })).status).toBe(204);
    const id = await submit(url, ['RST-0001']);
    expect(await poll(url, id)).toEqual([4]);
    expect(await poll(url, id)).toEqual([4]);
    expect(await poll(url, id)).toEqual([4]);
    expect((await state(url)).bulks).toEqual({ submitted: 1, applied: 0, open: 1 });
    expect(await poll(url, id)).toEqual([1]);
    expect((await state(url)).bulks).toEqual({ submitted: 1, applied: 1, open: 0 });
  });

  it('reset restores the seed', async () => {
    const url = await start();
    const id = await submit(url, ['RST-0001']);
    await poll(url, id);
    await poll(url, id);
    expect((await state(url)).skus['RST-0001']?.meta_keyword).toBe('after');
    expect((await send(url, '/_control/reset', 'POST')).status).toBe(204);
    const s = await state(url);
    expect(s.skus['RST-0001']).toEqual({ submissions: 0, applied: 0, meta_keyword: 'seed' });
    expect(s.bulks).toEqual({ submitted: 0, applied: 0, open: 0 });
  });

  it('control routes are absent when control is false', async () => {
    const url = await start(false);
    expect((await send(url, '/_control/state')).status).toBe(404);
    expect((await send(url, '/_control/reset', 'POST')).status).toBe(404);
    expect((await send(url, '/_control/open-polls', 'POST', { n: 1 })).status).toBe(404);
  });
});
