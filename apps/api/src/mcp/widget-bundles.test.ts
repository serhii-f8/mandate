// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveWidgetDir, WidgetBundles } from './widget-bundles.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mandate-widgets-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('MCP-5 widget bundles', () => {
  it('MCP-5 both files present: listed in order, read by exact URI, linked by kind', async () => {
    await writeFile(join(dir, 'changeset.html'), '<html>cs</html>');
    await writeFile(join(dir, 'approval.html'), '<html>ap</html>');
    const warn = vi.fn();
    const b = await WidgetBundles.load(dir, warn);
    expect(b.list().map((r) => r.uri)).toEqual(['ui://mandate/changeset.html', 'ui://mandate/approval.html']);
    expect(b.read('ui://mandate/approval.html')?.html).toBe('<html>ap</html>');
    expect(b.uriFor('changeset')).toBe('ui://mandate/changeset.html');
    expect(warn).not.toHaveBeenCalled();
  });

  it('MCP-5 an unknown or almost-equal URI reads nothing', async () => {
    await writeFile(join(dir, 'changeset.html'), 'x');
    const b = await WidgetBundles.load(dir, vi.fn());
    for (const uri of ['ui://mandate/changeset.html?x=1', 'UI://mandate/changeset.html', 'ui://mandate/../mandate/changeset.html']) {
      expect(b.read(uri)).toBeUndefined();
    }
  });

  it('MCP-5 resolveWidgetDir: MANDATE_WIDGET_DIR wins and is made absolute; otherwise packages/widgets/dist/ui', () => {
    expect(resolveWidgetDir('/srv/widgets')).toBe('/srv/widgets');
    expect(isAbsolute(resolveWidgetDir('rel/widgets'))).toBe(true);
    expect(resolveWidgetDir(undefined).endsWith(join('packages', 'widgets', 'dist', 'ui'))).toBe(true);
  });
});

describe('MCP-6 a missing bundle falls back to text', () => {
  it('MCP-6 a missing approval.html is absent and warned once', async () => {
    await writeFile(join(dir, 'changeset.html'), 'x');
    const warn = vi.fn();
    const b = await WidgetBundles.load(dir, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'widget bundle missing; ui://mandate/approval.html is not served (set MANDATE_WIDGET_DIR or run pnpm --filter @mandate/widgets build:widgets)',
      { file: join(dir, 'approval.html') },
    );
    expect(b.uriFor('approval')).toBeUndefined();
    expect(b.list().map((r) => r.kind)).toEqual(['changeset']);
  });

  it('MCP-6 an empty file counts as missing', async () => {
    await writeFile(join(dir, 'changeset.html'), '');
    await writeFile(join(dir, 'approval.html'), 'x');
    const warn = vi.fn();
    const b = await WidgetBundles.load(dir, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(b.uriFor('changeset')).toBeUndefined();
    expect(b.list().map((r) => r.kind)).toEqual(['approval']);
  });

  it('MCP-6 a missing directory warns for both and lists nothing', async () => {
    const warn = vi.fn();
    const b = await WidgetBundles.load(join(dir, 'nope'), warn);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(b.list()).toEqual([]);
    expect(WidgetBundles.empty().list()).toEqual([]);
  });
});
