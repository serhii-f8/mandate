import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

interface Job {
  if?: string;
  steps?: { run?: string }[];
}
interface Workflow {
  on: { schedule?: { cron: string }[] };
  jobs: Record<string, Job>;
}

describe('SEC-11 the repository ships a security policy and dependency scanning in CI', () => {
  it('SEC-11 SECURITY.md has the required headings and no e-mail address', () => {
    const md = read('SECURITY.md');
    for (const h of ['Supported versions', 'Reporting a vulnerability', 'Scope']) {
      expect(md).toMatch(new RegExp(`^#+ ${h}\\s*$`, 'm'));
    }
    expect(md).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  });

  it('SEC-11 ci.sh runs the dependency scan after install', () => {
    const sh = read('scripts/ci.sh');
    expect(sh).toContain('scripts/dependency-scan.sh');
    expect(sh.indexOf('dependency-scan.sh')).toBeGreaterThan(sh.indexOf('pnpm install'));
  });

  it('SEC-11 ci.yml has a dependency-scan job (after an install) and a weekly schedule that skips the other jobs', () => {
    const wf = parse(read('.github/workflows/ci.yml')) as Workflow;
    expect(wf.on.schedule?.map((s) => s.cron)).toEqual(['17 5 * * 1']);
    const runs = (wf.jobs['dependency-scan']?.steps ?? []).map((s) => s.run ?? '');
    const install = runs.findIndex((r) => r.includes('pnpm install --frozen-lockfile'));
    const scan = runs.findIndex((r) => r.includes('scripts/dependency-scan.sh'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(scan).toBeGreaterThan(install);
    for (const name of ['ci', 'compose']) {
      expect(wf.jobs[name]?.if).toBe("github.event_name != 'schedule'");
    }
    expect(wf.jobs['dependency-scan']?.if).toBeUndefined();
  });

  it('SEC-11 dependabot.yml lists npm, docker and github-actions', () => {
    const cfg = parse(read('.github/dependabot.yml')) as { version: number; updates: { 'package-ecosystem': string }[] };
    expect(cfg.version).toBe(2);
    expect(cfg.updates.map((u) => u['package-ecosystem'])).toEqual(expect.arrayContaining(['npm', 'docker', 'github-actions']));
  });
});
