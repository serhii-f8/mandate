import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeUpstream, type FakeUpstream } from './fake-upstream.js';
import { installFakeMagentoCatalog, type FakeMagentoCatalog } from './fake-magento-catalog.js';

function call(url: string, method = 'GET', body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

interface Op {
  id: number;
  status: number;
  result_message: string;
  serialized_data: unknown;
}

describe('fake Magento catalog', () => {
  let up: FakeUpstream | undefined;
  afterEach(async () => {
    await up?.close();
    up = undefined;
  });

  async function setup(openPolls?: number): Promise<{ cat: FakeMagentoCatalog; base: string }> {
    up = await startFakeUpstream();
    const cat = installFakeMagentoCatalog(up, {
      ...(openPolls === undefined ? {} : { openPolls }),
      products: [
        { sku: 'C-3', name: 'Three', status: 1, brand: 'acme', description: 'd3' },
        { sku: 'A-1', name: 'One', status: 1, brand: 'acme', description: 'd1' },
        { sku: 'B-2', name: 'Two', status: 2, brand: 'other' },
      ],
    });
    return { cat, base: `${up.url}${cat.basePath}` };
  }

  const bulk = (items: object[]): string => JSON.stringify(items.map((product) => ({ product })));
  const status = async (base: string, id: string): Promise<{ status: number; ops: Op[] }> => {
    const r = await call(`${base}/V1/bulk/${id}/detailed-status`);
    return { status: r.status, ops: r.status === 200 ? (JSON.parse(r.body) as { operations_list: Op[] }).operations_list : [] };
  };

  it('EXE-4 filters by brand eq and sku in, sorts by sku, and puts non-top-level fields into custom_attributes', async () => {
    const { base } = await setup();
    const q = new URLSearchParams({
      'searchCriteria[filter_groups][0][filters][0][field]': 'brand',
      'searchCriteria[filter_groups][0][filters][0][value]': 'acme',
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq',
      'searchCriteria[filter_groups][1][filters][0][field]': 'sku',
      'searchCriteria[filter_groups][1][filters][0][value]': 'C-3,A-1,B-2',
      'searchCriteria[filter_groups][1][filters][0][condition_type]': 'in',
    });
    const r = await call(`${base}/V1/products?${q.toString()}`);
    expect(r.status).toBe(200);
    const j = JSON.parse(r.body) as { items: Record<string, unknown>[]; total_count: number };
    expect(j.total_count).toBe(2);
    expect(j.items.map((i) => i.sku)).toEqual(['A-1', 'C-3']);
    expect(j.items[0]).toMatchObject({ sku: 'A-1', name: 'One', status: 1 });
    expect(j.items[0]?.brand).toBeUndefined();
    expect(j.items[0]?.custom_attributes).toEqual(
      expect.arrayContaining([
        { attribute_code: 'brand', value: 'acme' },
        { attribute_code: 'description', value: 'd1' },
      ]),
    );
  });

  it('EXE-4 supports like with a wildcard, case-insensitively, and paging', async () => {
    const { base } = await setup();
    const q = new URLSearchParams({
      'searchCriteria[filter_groups][0][filters][0][field]': 'name',
      'searchCriteria[filter_groups][0][filters][0][value]': '%O%',
      'searchCriteria[filter_groups][0][filters][0][condition_type]': 'like',
      pageSize: '1',
      currentPage: '2',
    });
    const j = JSON.parse((await call(`${base}/V1/products?${q.toString()}`)).body) as { items: { sku: string }[]; total_count: number };
    expect(j.total_count).toBe(2);
    expect(j.items.map((i) => i.sku)).toEqual(['B-2']);
  });

  it('EXE-4 accepts a bulk with 202 and a bulk_uuid, answers open once, then applies and reports status 1 per index in reverse order', async () => {
    const { base, cat } = await setup();
    const r = await call(
      `${base}/async/bulk/V1/products`,
      'POST',
      bulk([
        { sku: 'A-1', name: 'New', status: 1 },
        { sku: 'C-3', name: 'New3', status: 1, custom_attributes: [{ attribute_code: 'brand', value: 'zed' }] },
      ]),
    );
    expect(r.status).toBe(202);
    const accepted = JSON.parse(r.body) as { bulk_uuid: string; request_items: { id: number; status: string }[]; errors: boolean };
    expect(accepted.bulk_uuid).toBe('fake-bulk-1');
    expect(accepted.errors).toBe(false);
    expect(accepted.request_items.map((i) => i.id)).toEqual([0, 1]);
    expect(cat.submissions).toEqual([{ batchId: 'fake-bulk-1', skus: ['A-1', 'C-3'] }]);

    const open = await status(base, 'fake-bulk-1');
    expect(open.ops.map((o) => o.status)).toEqual([4, 4]);
    expect(cat.product('A-1')?.name).toBe('One');

    const applied: string[] = [];
    cat.onApplied = (sku) => applied.push(sku);
    const done = await status(base, 'fake-bulk-1');
    expect(done.ops.map((o) => [o.id, o.status])).toEqual([
      [1, 1],
      [0, 1],
    ]);
    expect(done.ops[0]?.result_message).toBe('fake upstream message C-3');
    expect(done.ops[0]?.serialized_data).toBeNull();
    expect(cat.product('A-1')?.name).toBe('New');
    expect(cat.product('C-3')).toMatchObject({ name: 'New3', brand: 'zed' });
    expect(applied).toEqual(['A-1', 'C-3']);

    // applies once only
    cat.set('A-1', { name: 'External' });
    await status(base, 'fake-bulk-1');
    expect(cat.product('A-1')?.name).toBe('External');
  });

  it('EXE-4 resets an omitted status to 1 and keeps an explicit status', async () => {
    const { base, cat } = await setup(0);
    await call(
      `${base}/async/bulk/V1/products`,
      'POST',
      bulk([
        { sku: 'B-2', name: 'Renamed' },
        { sku: 'A-1', name: 'Off', status: 2 },
      ]),
    );
    await status(base, 'fake-bulk-1');
    expect(cat.product('B-2')).toMatchObject({ name: 'Renamed', status: 1 });
    expect(cat.product('A-1')).toMatchObject({ name: 'Off', status: 2 });
  });

  it('CS-7 ends failItems SKUs and unknown SKUs in status 3 without applying them', async () => {
    const { base, cat } = await setup(0);
    cat.failItems(['A-1']);
    await call(
      `${base}/async/bulk/V1/products`,
      'POST',
      bulk([
        { sku: 'A-1', name: 'X', status: 1 },
        { sku: 'NOPE', name: 'Y', status: 1 },
        { sku: 'C-3', name: 'Z', status: 1 },
      ]),
    );
    const { ops } = await status(base, 'fake-bulk-1');
    expect(ops.map((o) => [o.id, o.status])).toEqual([
      [2, 1],
      [1, 3],
      [0, 3],
    ]);
    expect(cat.product('A-1')?.name).toBe('One');
    expect(cat.product('NOPE')).toBeUndefined();
    expect(cat.product('C-3')?.name).toBe('Z');
  });

  it('EXE-4 refuses a non-array body with 400 and records no submission', async () => {
    const { base, cat } = await setup();
    for (const body of [JSON.stringify({ product: { sku: 'A-1' } }), JSON.stringify([{ sku: 'A-1' }]), 'not json']) {
      const r = await call(`${base}/async/bulk/V1/products`, 'POST', body);
      expect(r.status).toBe(400);
      expect(JSON.parse(r.body)).toEqual({ message: 'Request body must be an array' });
    }
    expect(cat.submissions).toEqual([]);
  });

  it('EXE-4 answers 503 for the next n status requests after failStatusRequests(n)', async () => {
    const { base, cat } = await setup(0);
    await call(`${base}/async/bulk/V1/products`, 'POST', bulk([{ sku: 'A-1', name: 'X', status: 1 }]));
    cat.failStatusRequests(2);
    expect((await status(base, 'fake-bulk-1')).status).toBe(503);
    expect((await status(base, 'fake-bulk-1')).status).toBe(503);
    expect((await status(base, 'fake-bulk-1')).status).toBe(200);
    expect((await status(base, 'unknown')).status).toBe(404);
  });

  it('routeMatch handles paths an exact route does not', async () => {
    up = await startFakeUpstream();
    up.route('GET', '/a/1', () => ({ status: 200, body: 'exact' }));
    up.routeMatch('GET', /^\/a\/(\d+)$/, (req) => ({ status: 200, body: `match ${req.path}` }));
    expect((await call(`${up.url}/a/1`)).body).toBe('exact');
    expect((await call(`${up.url}/a/2`)).body).toBe('match /a/2');
    expect((await call(`${up.url}/b/2`)).status).toBe(404);
    expect((await call(`${up.url}/a/2`, 'POST')).status).toBe(404);
  });
});
