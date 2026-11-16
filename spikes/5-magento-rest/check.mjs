// Spike 5 assertions. Assumes the sandbox is up (./up.sh). Resets its own product data.
import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assert, login, api, calls, sleep, waitBulk, results, BASE } from './lib.mjs';

mkdirSync('out', { recursive: true });
const obs = {};
const DC = 'docker compose -p fde-spike-5';
const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
const N = 20;
const SKUS = Array.from({ length: N }, (_, i) => `SPK-${String(i + 1).padStart(3, '0')}`);
const desc = (p) => p.custom_attributes?.find((a) => a.attribute_code === 'description')?.value;
const attr = (p, c) => p.custom_attributes?.find((a) => a.attribute_code === c)?.value;
const descAttr = (v) => ({ custom_attributes: [{ attribute_code: 'description', value: v }] });
const getP = async (sku) => (await api('GET', `/all/V1/products/${sku}`)).json; // admin scope: same scope as the /all/ writes

function consumerRunning() {
  return spawnSync('bash', ['-c', `${DC} exec -T web pgrep -f "queue:consumers:start async.operations.all"`]).status === 0;
}
function stopConsumer() { spawnSync('bash', ['-c', `${DC} exec -T web pkill -f "queue:consumers:start"`]); }
function startConsumer() {
  sh(`${DC} exec -d -u www-data -e HOME=/tmp/wwwhome web php -d memory_limit=-1 bin/magento queue:consumers:start async.operations.all`);
}

// ---------- environment + data reset ----------
await login();
stopConsumer(); await sleep(1000); startConsumer(); // fresh consumer: a long-running one caches EAV metadata

async function ensureAttribute(code, label) {
  if ((await api('GET', `/V1/products/attributes/${code}`)).status === 200) return;
  await api('POST', '/V1/products/attributes', { attribute: { attribute_code: code, frontend_input: 'text', default_frontend_label: label, is_required: false, scope: 'global' } });
  await api('POST', '/V1/products/attribute-sets/attributes', { attributeSetId: 4, attributeGroupId: 7, attributeCode: code, sortOrder: 60 });
  sh(`${DC} exec -T -u www-data web php bin/magento cache:flush`); // EAV metadata is cached; needed before first use
  stopConsumer(); await sleep(1000); startConsumer();
}
await ensureAttribute('spike_brand', 'Spike Brand');
await ensureAttribute('spike_changeset', 'Spike Change-set marker');

async function resetProducts() {
  const del = await api('GET', '/V1/products?searchCriteria[pageSize]=200&searchCriteria[filter_groups][0][filters][0][field]=sku&searchCriteria[filter_groups][0][filters][0][value]=SPK-%25&searchCriteria[filter_groups][0][filters][0][condition_type]=like');
  for (const it of del.json.items ?? []) await api('DELETE', `/V1/products/${it.sku}`);
  await api('DELETE', '/V1/products/T-1');
  for (const [i, sku] of SKUS.entries()) {
    const r = await api('POST', '/all/V1/products', {
      product: { sku, name: `Spike product ${i + 1}`, price: 10 + i, attribute_set_id: 4, type_id: 'simple', status: 1, visibility: 4,
        custom_attributes: [{ attribute_code: 'description', value: `before-${sku}` }, { attribute_code: 'spike_brand', value: i < 10 ? 'Acme' : 'Globex' }] },
    });
    if (r.status !== 200) throw new Error(`seed ${sku}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  // deleting + recreating a SKU leaves a long-running consumer with a stale product-by-SKU cache (observed: 'product with ID N does not exist')
  stopConsumer(); await sleep(1000); startConsumer();
}
await resetProducts();
const seeded = await getP(SKUS[0]);
console.log(`seeded ${N} products; ${SKUS[0]} description=${desc(seeded)} brand=${attr(seeded, 'spike_brand')}`);
const consumerWasRunning = consumerRunning();
obs.consumerRunning = consumerWasRunning;

// ---------- 1. schema ----------
const full = await api('GET', '/rest/all/schema?services=all'.replace('/rest', ''), undefined, { raw: true });
writeFileSync('out/schema-full.json', full.text);
const fullBytes = Buffer.byteLength(full.text);
const fullSha = createHash('sha256').update(full.text).digest('hex');
assert('schema-fetched', full.status === 200 && fullBytes > 100000, `${fullBytes} bytes sha256=${fullSha}`);
const filt = await api('GET', '/all/schema?services=catalogProductRepositoryV1,asynchronousOperationsBulkStatusV1'.replace(/^/, ''), undefined, { raw: true });
writeFileSync('out/schema-filtered.json', filt.text);
const filtJson = JSON.parse(filt.text);
assert('filtered-schema-fetched', filt.status === 200 && Object.keys(filtJson.paths ?? {}).length > 0 && Buffer.byteLength(filt.text) < fullBytes / 5,
  `${Buffer.byteLength(filt.text)} bytes, paths=${Object.keys(filtJson.paths ?? {}).join(' ')}`);
const fullJson = JSON.parse(full.text);
obs.schema = {
  fullBytes, fullSha, format: fullJson.swagger ?? fullJson.openapi, paths: Object.keys(fullJson.paths).length,
  definitions: Object.keys(fullJson.definitions).length,
  asyncRoutesInSchema: Object.keys(fullJson.paths).filter((p) => /async|bulk/i.test(p)),
  bulkStatusInFull: Object.keys(fullJson.paths).filter((p) => p.includes('/bulk/')),
  filteredBytes: Buffer.byteLength(filt.text), filteredPaths: Object.keys(filtJson.paths),
};
for (const [k, f] of [['full', 'out/schema-full.json'], ['filtered', 'out/schema-filtered.json']]) {
  const r = spawnSync('node', ['parse-schema.mjs', f, 'convert'], { encoding: 'utf8' });
  let o = null; try { o = JSON.parse(r.stdout); } catch { /* */ }
  obs[`parse_${k}`] = o ?? { error: r.stderr.slice(0, 300) };
  if (k === 'full') assert('schema-parses', !!o && o.valid && o.derefPaths === o.paths, JSON.stringify(o));
  else assert('filtered-schema-parses', !!o && o.valid && o.derefPaths === o.paths, JSON.stringify(o));
}

// ---------- 2. sync PUT semantics ----------
const s1 = await api('PUT', `/all/V1/products/${SKUS[0]}`, { product: descAttr('sync-after-1') });
const p0 = await getP(SKUS[0]);
assert('sync-put-is-partial-merge', s1.status === 200 && desc(p0) === 'sync-after-1' && p0.price === 10 && p0.name === 'Spike product 1' && attr(p0, 'spike_brand') === 'Acme',
  `desc=${desc(p0)} price=${p0.price} brand=${attr(p0, 'spike_brand')}`);

// store scope observation: /V1 (default store view) vs /all/V1 (global)
await api('PUT', `/V1/products/${SKUS[1]}`, { product: descAttr('via-default-scope') });
await api('PUT', `/all/V1/products/${SKUS[2]}`, { product: descAttr('via-all-scope') });
const rows = sh(`${DC} exec -T db mariadb -uroot -pspike-root magento -N -e "select e.sku, t.store_id, t.value from catalog_product_entity_text t join catalog_product_entity e on e.entity_id=t.entity_id join eav_attribute a on a.attribute_id=t.attribute_id and a.attribute_code='description' where e.sku in ('${SKUS[1]}','${SKUS[2]}') order by e.sku, t.store_id"`).trim().split('\n');
obs.scopeRows = rows;

// ---------- 3. idempotency: sync retry ----------
await resetProducts();
const before1 = await getP(SKUS[3]);
await api('PUT', `/all/V1/products/${SKUS[3]}`, { product: descAttr('sync-after') });
const a1 = await getP(SKUS[3]);
await sleep(1100);
await api('PUT', `/all/V1/products/${SKUS[3]}`, { product: descAttr('sync-after') });
const a2 = await getP(SKUS[3]);
// Volatile server-maintained fields observed to change on an identical rewrite: updated_at and stock_item.low_stock_date.
const strip = (p) => JSON.stringify({ ...p, updated_at: undefined, extension_attributes: { ...p.extension_attributes, stock_item: { ...p.extension_attributes?.stock_item, low_stock_date: undefined } } });
assert('sync-retry-same-state', strip(a1) === strip(a2) && desc(a2) === 'sync-after', `updated_at ${a1.updated_at} -> ${a2.updated_at}`);
obs.syncRetry = { updatedAtChangedOnIdenticalPut: a1.updated_at !== a2.updated_at, before: desc(before1) };

// ---------- 4. bulk ----------
await resetProducts();
const items = SKUS.map((sku) => ({ product: { sku, ...descAttr(`bulk-after-${sku}`) } }));
const t0 = Date.now();
const acc = await api('POST', '/all/async/bulk/V1/products', items);
assert('bulk-accepted', acc.status === 202 && !!acc.json.bulk_uuid && acc.json.request_items?.length === N && acc.json.errors === false,
  `status=${acc.status} uuid=${acc.json.bulk_uuid} items=${acc.json.request_items?.length}`);
const done = await waitBulk(acc.json.bulk_uuid, N);
const ops = done.status.operations_list;
assert('bulk-status-complete', ops.length === N && ops.every((o) => o.status === 1), `ms=${done.ms} statuses=${[...new Set(ops.map((o) => o.status))]}`);
const readBack = await Promise.all(SKUS.map(getP));
assert('bulk-values-applied', readBack.every((p, i) => desc(p) === `bulk-after-${SKUS[i]}`), `${readBack.filter((p, i) => desc(p) === `bulk-after-${SKUS[i]}`).length}/${N}`);
obs.bulk = { acceptedBody: acc.json, totalMs: Date.now() - t0, statusSample: done.status, detailed: (await api('GET', `/V1/bulk/${acc.json.bulk_uuid}/detailed-status`)).json };
const shape = (await api('GET', `/V1/bulk/${acc.json.bulk_uuid}/detailed-status`)).json;
assert('bulk-per-item-addressable', shape.operations_list?.length === N && shape.operations_list.every((o, i) => o.id === i || typeof o.id === 'number') &&
  !!shape.operations_list[0].result_message !== undefined, `keys=${Object.keys(shape.operations_list?.[0] ?? {})}`);
// PUT bySku bulk route as documented
const putBulk = await api('PUT', '/all/async/bulk/V1/products/bySku', [{ sku: SKUS[0], product: descAttr('x') }]);
obs.putBulkBySku = { status: putBulk.status, body: putBulk.json };

// partial failure: good, invalid attribute set, new sku without name/price (create path), invalid status
const mixed = [
  { product: { sku: SKUS[0], ...descAttr('mixed-ok-1') } },
  { product: { sku: SKUS[1], attribute_set_id: 99999 } },
  { product: { sku: 'SPK-NEW-NO-NAME' } },
  { product: { sku: SKUS[2], custom_attributes: [{ attribute_code: 'url_key', value: 'spike-product-1' }] } }, // url_key collision
  { product: { sku: SKUS[3], ...descAttr('mixed-ok-2') } },
];
// a type error in ONE item rejects the whole request synchronously, nothing is queued
const typeErr = await api('POST', '/all/async/bulk/V1/products', [{ product: { sku: SKUS[4], ...descAttr('type-err-ok-item') } }, { product: { sku: SKUS[5], price: 'not-a-number' } }]);
assert('bulk-type-error-rejects-whole-request', typeErr.status === 400 && !typeErr.json.bulk_uuid, `${typeErr.status} ${JSON.stringify(typeErr.json).slice(0, 160)}`);
const mAcc = await api('POST', '/all/async/bulk/V1/products', mixed);
const mDone = await waitBulk(mAcc.json.bulk_uuid, mixed.length);
const mDet = (await api('GET', `/V1/bulk/${mAcc.json.bulk_uuid}/detailed-status`)).json;
obs.partial = { accepted: mAcc.json, status: mDone.status, detailed: mDet };
const byId = Object.fromEntries(mDet.operations_list.map((o) => [o.id, o]));
const st = mixed.map((_, i) => byId[i]?.status);
const okP = [await getP(SKUS[0]), await getP(SKUS[3])];
assert('bulk-partial-failure-per-item', mAcc.status === 202 && mAcc.json.errors === false && st[0] === 1 && st[4] === 1 && [1, 2, 3].every((i) => st[i] === 3) &&
  desc(okP[0]) === 'mixed-ok-1' && desc(okP[1]) === 'mixed-ok-2', `status by payload index=${JSON.stringify(st)} messages=${JSON.stringify(mixed.map((_, i) => (byId[i]?.result_message ?? '').slice(0, 50)))}`);
assert('bulk-failed-item-carries-its-input', JSON.parse(byId[1].serialized_data).meta_information.includes(SKUS[1]) && byId[0].result_serialized_data.includes(SKUS[0]), 'failed op: serialized_data.meta_information holds the request; ok op: result_serialized_data holds the saved product');
const pNew = await api('GET', '/V1/products/SPK-NEW-NO-NAME');
obs.partial.newSkuCreated = pNew.status;

// ---------- 5. idempotency: bulk retry ----------
await resetProducts();
const idem = SKUS.slice(0, 5).map((sku) => ({ product: { sku, ...descAttr(`idem-${sku}`) } }));
const b1 = await api('POST', '/all/async/bulk/V1/products', idem); await waitBulk(b1.json.bulk_uuid, 5);
const snap1 = await Promise.all(SKUS.slice(0, 5).map(getP));
await sleep(1100);
const b2 = await api('POST', '/all/async/bulk/V1/products', idem); await waitBulk(b2.json.bulk_uuid, 5);
const snap2 = await Promise.all(SKUS.slice(0, 5).map(getP));
const flat = (o, p = '', out = {}) => { for (const [k, v] of Object.entries(o ?? {})) (v && typeof v === 'object' && !Array.isArray(v)) ? flat(v, p + k + '.', out) : (out[p + k] = JSON.stringify(v)); return out; };
const diffKeys = (x, y) => { const a = flat(x), b = flat(y); return Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]); };
assert('bulk-retry-same-state', snap1.every((p, i) => strip(p) === strip(snap2[i])) && snap2.every((p, i) => desc(p) === `idem-${SKUS[i]}`),
  `differing keys=${JSON.stringify(diffKeys(snap1[0], snap2[0]))} uuid1=${b1.json.bulk_uuid} uuid2=${b2.json.bulk_uuid} hash1==hash2:${b1.json.request_items[0].data_hash === b2.json.request_items[0].data_hash} updated_at changed:${snap1[0].updated_at !== snap2[0].updated_at}`);
obs.bulkRetry = { sameUuid: b1.json.bulk_uuid === b2.json.bulk_uuid, sameDataHash: b1.json.request_items[0].data_hash === b2.json.request_items[0].data_hash, updatedAtChanged: snap1[0].updated_at !== snap2[0].updated_at };
assert('bulk-retry-new-uuid-no-dedupe', b1.json.bulk_uuid !== b2.json.bulk_uuid, 'Magento issues a new bulk_uuid for an identical payload');

// ---------- 6. read-before-write (a): batched read via search, 1 call per batch ----------
await resetProducts();
const cs = SKUS.map((sku) => ({ sku, before: `before-${sku}`, after: `cs-after-${sku}` }));
async function batchedRead(skus) {
  const q = `/all/V1/products?searchCriteria[pageSize]=${skus.length}&searchCriteria[filter_groups][0][filters][0][field]=sku&searchCriteria[filter_groups][0][filters][0][value]=${skus.join(',')}&searchCriteria[filter_groups][0][filters][0][condition_type]=in`;
  const r = await api('GET', q);
  return Object.fromEntries((r.json.items ?? []).map((p) => [p.sku, p]));
}
async function applyChangeSet(csItems, { marker } = {}) {
  const c0 = calls.n;
  const cur = await batchedRead(csItems.map((i) => i.sku));
  const toWrite = [], skipped = [], drift = [];
  for (const it of csItems) {
    const v = desc(cur[it.sku]);
    if (v === it.after) skipped.push(it.sku);
    else if (v === it.before) toWrite.push(it);
    else drift.push(it.sku);
  }
  let polls = 0, failed = [];
  if (toWrite.length) {
    const body = toWrite.map((it) => ({ product: { sku: it.sku, custom_attributes: [{ attribute_code: 'description', value: it.after }, ...(marker ? [{ attribute_code: 'spike_changeset', value: `${marker}:${it.sku}` }] : [])] } }));
    const r = await api('POST', '/all/async/bulk/V1/products', body);
    const t = Date.now();
    for (;;) { polls++; const s = await api('GET', `/V1/bulk/${r.json.bulk_uuid}/status`); const o = s.json.operations_list ?? []; if (o.length >= body.length && o.every((x) => x.status !== 4)) break; await sleep(500); }
    void t;
    failed = (await api('GET', `/V1/bulk/${r.json.bulk_uuid}/status`)).json.operations_list.filter((x) => x.status !== 1).map((x) => `${x.id}:${x.status}:${(x.result_message ?? '').slice(0, 60)}`);
  }
  return { calls: calls.n - c0, written: toWrite.length, skipped: skipped.length, drift, polls, failed };
}
const run1 = await applyChangeSet(cs);
const run2 = await applyChangeSet(cs); // retry after full success
const fin = await batchedRead(SKUS);
assert('rbw-first-run-writes-all', run1.written === N && run1.skipped === 0 && Object.values(fin).every((p) => desc(p) === `cs-after-${p.sku}`), JSON.stringify(run1));
assert('rbw-retry-skips-all-zero-writes', run2.written === 0 && run2.skipped === N, `retry calls=${run2.calls} (1 batched read, 0 writes) ${JSON.stringify(run2)}`);
// drift
await resetProducts();
await api('PUT', `/all/V1/products/${SKUS[7]}`, { product: descAttr('someone-else-edited') });
const run3 = await applyChangeSet(cs);
assert('rbw-drift-detected-and-skipped', run3.drift.length === 1 && run3.drift[0] === SKUS[7] && run3.written === N - 1 && desc(await getP(SKUS[7])) === 'someone-else-edited', JSON.stringify(run3));
obs.callCounts = { rbwFirstRun: run1, rbwRetry: run2, rbwDrift: run3 };

// ---------- 7. marker attribute (b) ----------
await resetProducts();
const runM = await applyChangeSet(cs.slice(0, 5), { marker: 'CS-1' });
const mk = await batchedRead(SKUS.slice(0, 5));
assert('marker-written-and-batch-readable', Object.values(mk).every((p) => attr(p, 'spike_changeset') === `CS-1:${p.sku}`), `calls=${runM.calls} ${JSON.stringify(runM)} marker=${attr(mk[SKUS[0]], 'spike_changeset')}`);
obs.markerCalls = runM;

// ---------- 8. async retry hazards (consumer stopped = queued) ----------
await resetProducts();
stopConsumer(); await sleep(1500);
const hazardItems = SKUS.slice(0, 3).map((sku) => ({ product: { sku, ...descAttr(`queued-${sku}`) } }));
const q1 = await api('POST', '/all/async/bulk/V1/products', hazardItems);
// the activity "times out" and is retried: read-before-write still sees `before` because the first bulk is still queued
const seenWhileQueued = await batchedRead(SKUS.slice(0, 3));
const stillBefore = Object.values(seenWhileQueued).every((p) => desc(p).startsWith('before-'));
const q2 = await api('POST', '/all/async/bulk/V1/products', hazardItems); // retry re-submits
// an external edit lands while both are queued
await api('PUT', `/all/V1/products/${SKUS[0]}`, { product: descAttr('external-edit-while-queued') });
const statusQueued = (await api('GET', `/V1/bulk/${q1.json.bulk_uuid}/status`)).json;
startConsumer();
await waitBulk(q1.json.bulk_uuid, 3); await waitBulk(q2.json.bulk_uuid, 3);
const finalQ = await getP(SKUS[0]);
assert('queued-resubmit-visible-as-open', statusQueued.operations_list?.length === 3 && statusQueued.operations_list.every((o) => o.status === 4), `status while consumer stopped: ${JSON.stringify(statusQueued.operations_list?.map((o) => o.status))}`);
assert('queued-readback-cannot-see-pending-write', stillBefore, 'read-before-write on retry still sees before; cannot tell a queued submission from a never-submitted one');
assert('queued-write-clobbers-external-edit', desc(finalQ) === `queued-${SKUS[0]}`, `external edit lost: final=${desc(finalQ)} (documents the TOCTOU hazard; mitigation = persist bulk_uuid, poll it before resubmitting)`);
obs.hazard = { q1: q1.json.bulk_uuid, q2: q2.json.bulk_uuid };


// ---------- 9. scope + status gotchas ----------
await resetProducts();
// (i) bulk POST and sync PUT with a description-only body must not reset other fields such as status
await api('PUT', `/all/V1/products/${SKUS[5]}`, { product: { status: 2 } });
const dis = await getP(SKUS[5]);
const sb = await api('POST', '/all/async/bulk/V1/products', [{ product: { sku: SKUS[5], ...descAttr('desc-only-bulk') } }]); await waitBulk(sb.json.bulk_uuid, 1);
const afterBulk = await getP(SKUS[5]);
await api('PUT', `/all/V1/products/${SKUS[6]}`, { product: { status: 2 } });
await api('PUT', `/all/V1/products/${SKUS[6]}`, { product: descAttr('desc-only-sync') });
const afterSync = await getP(SKUS[6]);
assert('disabled-product-status-kept-by-sync-put', afterSync.status === 2 && desc(afterSync) === 'desc-only-sync', `status=${afterSync.status}`);
// HAZARD (characterised): the async/bulk POST path re-enables a disabled product when `status` is omitted.
assert('HAZARD-bulk-post-resets-omitted-status-to-enabled', dis.status === 2 && afterBulk.status === 1 && desc(afterBulk) === 'desc-only-bulk', `status before=${dis.status} after=${afterBulk.status}`);
// (ii) a store-view write shadows a global write when reading the store view
await api('PUT', `/V1/products/${SKUS[8]}`, { product: descAttr('store-view-value') });          // default store view (store_id 1)
const sc = await api('POST', '/all/async/bulk/V1/products', [{ product: { sku: SKUS[8], ...descAttr('global-value') } }]); await waitBulk(sc.json.bulk_uuid, 1);
const viaAll = desc((await api('GET', `/all/V1/products/${SKUS[8]}`)).json);
const viaView = desc((await api('GET', `/V1/products/${SKUS[8]}`)).json);
assert('store-view-value-shadows-global-write', viaAll === 'global-value' && viaView === 'store-view-value', `/all read=${viaAll}; /V1 (default store view) read=${viaView}`);

await resetProducts();
await api('PUT', `/all/V1/products/${SKUS[10]}`, { product: { status: 2 } });
const as = await api('PUT', `/all/async/V1/products/${SKUS[10]}`, { product: descAttr('async-single-put') }); await waitBulk(as.json.bulk_uuid, 1);
const asp = await getP(SKUS[10]);
assert('HAZARD-async-single-put-resets-omitted-status-to-enabled', asp.status === 1 && desc(asp) === 'async-single-put', `status=${asp.status} (sync PUT keeps it; the /async paths reset it)`);
await api('PUT', `/all/V1/products/${SKUS[11]}`, { product: { status: 2 } });
const ex = await api('POST', '/all/async/bulk/V1/products', [{ product: { sku: SKUS[11], status: 2, ...descAttr('explicit-status') } }]); await waitBulk(ex.json.bulk_uuid, 1);
const exp = await getP(SKUS[11]);
assert('bulk-post-with-explicit-status-keeps-status', exp.status === 2 && desc(exp) === 'explicit-status', `status=${exp.status}`);

// ---------- done ----------
writeFileSync('out/observations.json', JSON.stringify(obs, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed; HTTP calls: ${calls.n}; observations: out/observations.json`);
process.exit(failed.length ? 1 : 0);
