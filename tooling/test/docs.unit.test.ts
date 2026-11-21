// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extract } from '../doc-test/extract.mjs';
import { PAGES, SECTIONS } from '../doc-test/run.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

function guidePages(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...guidePages(rel));
    else if (e.endsWith('.md')) out.push(rel);
  }
  return out;
}

/** Public documents that exist now; later tasks add README.md and CHANGELOG.md. */
function publicDocs(): string[] {
  const fixed = ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'examples/README.md'];
  return [...fixed.filter((f) => existsSync(join(root, f))), ...guidePages('docs/guide')];
}

function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function headings(md: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = !fence ? /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line) : null;
    if (m?.[1]) out.push(slug(m[1].replace(/[`*]/g, '')));
  }
  return out;
}

interface Link {
  target: string;
  heading: string;
}

/** Relative links outside code fences, with the nearest preceding heading. */
function links(md: string): Link[] {
  const out: Link[] = [];
  let fence = false;
  let heading = '';
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (h?.[1]) heading = h[1];
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const t = m[1] ?? '';
      if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) continue;
      out.push({ target: t, heading });
    }
  }
  return out;
}

describe('NFR-9 public docs', () => {
  const docs = publicDocs();

  it('NFR-9 public docs exist for the lint to cover', () => {
    expect(docs).toContain('docs/guide/README.md');
    expect(docs).toContain('CONTRIBUTING.md');
  });

  it('NFR-9 every relative link resolves to a file or directory, and #anchor to a heading', () => {
    const bad: string[] = [];
    for (const doc of docs) {
      for (const { target } of links(read(doc))) {
        const [path, anchor] = target.split('#') as [string, string | undefined];
        const file = path === '' ? join(root, doc) : resolve(root, dirname(doc), decodeURIComponent(path));
        if (!existsSync(file)) {
          bad.push(`${doc}: ${target} (missing)`);
          continue;
        }
        if (anchor && statSync(file).isFile() && file.endsWith('.md')) {
          if (!headings(readFileSync(file, 'utf8')).includes(anchor.toLowerCase())) bad.push(`${doc}: ${target} (no heading)`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('NFR-9 no public doc links into .superpowers/', () => {
    const bad = docs.filter((d) => read(d).includes('.superpowers/'));
    expect(bad).toEqual([]);
  });

  it('NFR-9 guide links into docs/ outside docs/guide/ sit under a Background heading', () => {
    const bad: string[] = [];
    for (const doc of docs.filter((d) => d === 'README.md' || d.startsWith('docs/guide/'))) {
      for (const { target, heading } of links(read(doc))) {
        const path = target.split('#')[0] ?? '';
        if (path === '') continue;
        const rel = relative(root, resolve(root, dirname(doc), path));
        const intoDocs = rel.startsWith('docs/') && !rel.startsWith('docs/guide/');
        if (intoDocs && !/^Background\b/i.test(heading)) bad.push(`${doc}: ${target} under "${heading}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('NFR-9 every page listed in docs/guide/README.md exists', () => {
    const listed = links(read('docs/guide/README.md')).map((l) => l.target.split('#')[0] ?? '');
    expect(listed.length).toBeGreaterThanOrEqual(13);
    for (const p of listed) expect(existsSync(join(root, 'docs/guide', p)), p).toBe(true);
  });

  it('NFR-9 every guide page is listed in docs/guide/README.md', () => {
    const listed = new Set(links(read('docs/guide/README.md')).map((l) => l.target.split('#')[0]));
    const pages = readdirSync(join(root, 'docs/guide')).filter((f) => f.endsWith('.md') && f !== 'README.md');
    expect(pages.filter((p) => !listed.has(p))).toEqual([]);
  });

  // R8: env names are unquoted object keys in runtime-env.ts.
  it('NFR-9 configuration.md mentions every top-level schema key and every runtime-env name', () => {
    const page = read('docs/guide/configuration.md');
    const schema = JSON.parse(read('packages/config/schema/aiops-config.v1.json')) as { properties: Record<string, unknown> };
    const keys = Object.keys(schema.properties);
    expect(keys.length).toBeGreaterThanOrEqual(12);
    const envSource = read('packages/config/src/runtime-env.ts');
    const names = [...new Set([...envSource.matchAll(/^\s+((?:AIOPS|API|OIDC|TEMPORAL|DATABASE|LOG|OTEL)_[A-Z0-9_]+):/gm)].map((m) => m[1] ?? ''))];
    expect(names.length).toBeGreaterThanOrEqual(30);
    const missing = [...keys.map((k) => `\`${k}\``), ...names.map((n) => `\`${n}\``)].filter((t) => !page.includes(t));
    expect(missing).toEqual([]);
  });

  // R9: the acceptance script maps runner sections to checks in SECTION_CHECKS=( section:check ... ).
  it('NFR-9 every doc-test section named by phase-10.sh exists', () => {
    const script = read('scripts/acceptance/phase-10.sh');
    const body = /^SECTION_CHECKS=\(\n([\s\S]*?)^\)$/m.exec(script)?.[1] ?? '';
    const map = [...body.matchAll(/^\s+([a-z]+):(docs-[a-z-]+)\s*$/gm)].map((m) => ({ section: m[1] ?? '', check: m[2] ?? '' }));
    expect(map.map((e) => e.section)).toEqual([...SECTIONS]);
    const blocks = extract(
      PAGES.map((p) => ({ path: `docs/guide/${p}`, text: read(`docs/guide/${p}`) })),
      SECTIONS,
    );
    const empty = map.filter((e) => (blocks.get(e.section) ?? []).length === 0).map((e) => e.section);
    expect(empty).toEqual([]);
  });
});

describe('NFR-18 release notes', () => {
  it('NFR-18 CHANGELOG 1.0.0 carries the upgrade notes', () => {
    const changelog = read('CHANGELOG.md');
    const missing = ['write_opaque', 'configuration_mismatch', 'input_schema', 'disabled ~', 'Mcp-Param', 'bare token', 'config apply', '^1.0.0'].filter(
      (s) => !changelog.includes(s),
    );
    expect(missing).toEqual([]);
  });
});
