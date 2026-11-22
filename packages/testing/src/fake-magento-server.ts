// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { startFakeUpstream } from './fake-upstream.js';
import { installFakeMagentoCatalog, type FakeMagentoProduct } from './fake-magento-catalog.js';

export interface FakeMagentoServerOptions {
  readonly host: string;
  readonly port: number;
  /** Number of seed products `RST-0001`... (brand `restart`, status 1, meta_keyword `seed`). */
  readonly products: number;
  /** Mounts the `/_control/*` routes. */
  readonly control: boolean;
}

/** The fake Magento catalog as a standalone server for the restart acceptance script (NFR-1). */
export async function startFakeMagentoServer(opts: FakeMagentoServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  const products: FakeMagentoProduct[] = [];
  for (let i = 1; i <= opts.products; i += 1) {
    products.push({
      sku: `RST-${String(i).padStart(4, '0')}`,
      name: `Restart product ${i}`,
      status: 1,
      brand: 'restart',
      meta_keyword: 'seed',
    });
  }
  const up = await startFakeUpstream({ host: opts.host, port: opts.port });
  const catalog = installFakeMagentoCatalog(up, { products });

  if (opts.control) {
    up.route('GET', '/_control/state', () => {
      const skus: Record<string, { submissions: number; applied: number; meta_keyword: unknown }> = {};
      for (const p of products) skus[p.sku] = { submissions: 0, applied: 0, meta_keyword: catalog.product(p.sku)?.meta_keyword };
      let applied = 0;
      const all = catalog.bulks();
      for (const b of all) {
        if (b.applied) applied += 1;
        for (const sku of b.skus) {
          const entry = skus[sku];
          if (entry === undefined) continue; // not a seed SKU
          entry.submissions += 1;
          if (b.applied) entry.applied += 1;
        }
      }
      return { status: 200, body: { skus, bulks: { submitted: all.length, applied, open: all.length - applied } } };
    });
    up.route('POST', '/_control/open-polls', (req) => {
      let n: unknown;
      try {
        n = (JSON.parse(req.body) as { n?: unknown }).n;
      } catch {
        n = undefined;
      }
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return { status: 400, body: { error: 'n must be a non-negative integer' } };
      catalog.openPolls = n;
      return { status: 204 };
    });
    up.route('POST', '/_control/reset', () => {
      catalog.reset();
      return { status: 204 };
    });
  }

  return { url: up.url, close: () => up.close() };
}
