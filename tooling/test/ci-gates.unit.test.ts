import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const codeLines = (p: string): string => read(p).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

interface Job {
  steps?: { run?: string }[];
}
const jobRuns = (): Record<string, string[]> => {
  const wf = parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, Job> };
  return Object.fromEntries(Object.entries(wf.jobs).map(([n, j]) => [n, (j.steps ?? []).map((s) => s.run ?? '')]));
};

describe('NFR-15 ci.sh runs the integration tests against real PostgreSQL and the Temporal test server', () => {
  it('NFR-15 ci.sh runs pnpm test:int', () => {
    expect(codeLines('scripts/ci.sh')).toMatch(/\bpnpm test:int\b/);
  });
  it('NFR-15 the shared fixture starts a Testcontainers PostgreSQL and the worker harness the Temporal test server', () => {
    expect(read('packages/testing/src/postgres.ts')).toMatch(/from '@testcontainers\/postgresql'/);
    expect(read('apps/worker/test/support/harness.ts')).toMatch(/import \{[^}]*\bTestWorkflowEnvironment\b[^}]*\} from '@temporalio\/testing'/);
  });
  it('NFR-15 every db integration test uses the shared PostgreSQL fixture', () => {
    const dir = 'packages/db/test/integration';
    const files = readdirSync(join(root, dir)).filter((f) => f.endsWith('.int.test.ts'));
    expect(files.length).toBeGreaterThan(0);
    const importsFixture = (src: string): boolean =>
      src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
        .match(/import\s*\{([^}]*)\}\s*from\s*'@aiops\/testing'/g)
        ?.some((m) => /\bstartPostgres\b/.test(m)) ?? false;
    const bad = files.filter((f) => !importsFixture(read(join(dir, f))));
    expect(bad).toEqual([]);
  });
});

describe('NFR-16 the conformance suite runs in the e2e project', () => {
  it('NFR-16 the conformance test matches the e2e include and ci.sh runs pnpm test:e2e', () => {
    expect(read('apps/api/vitest.config.ts')).toContain('packageConfig(');
    const shared = read('vitest.shared.ts');
    expect(shared).toContain("name: 'e2e'");
    expect(shared).toContain("include: ['test/e2e/**/*.e2e.test.ts']");
    expect(existsSync(join(root, 'apps/api/test/e2e/conformance.e2e.test.ts'))).toBe(true);
    expect(codeLines('scripts/ci.sh')).toMatch(/\bpnpm test:e2e\b/);
  });
});

describe('NFR-17 every preset package ships contract tests that run in pnpm test', () => {
  const presets = readdirSync(join(root, 'presets'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  it('NFR-17 presets are workspace packages', () => {
    expect(presets.length).toBeGreaterThan(0);
    expect((parse(read('pnpm-workspace.yaml')) as { packages: string[] }).packages).toContain('presets/*');
  });
  for (const name of presets) {
    it(`NFR-17 preset ${name} has a unit contract test, recordings and a vitest test script`, () => {
      const tests = walk(`presets/${name}/test`).filter((f) => f.endsWith('.unit.test.ts'));
      const valueImport = /import\s*\{([^}]*)\}\s*from\s*'@aiops\/testing'/;
      const ok = tests.filter((f) => {
        const names = (valueImport.exec(read(f))?.[1] ?? '').split(',').map((s) => s.trim());
        return names.some((n) => n === 'replayRecordings' || n === 'contractRead');
      });
      expect(ok.length).toBeGreaterThan(0);
      const rec = `presets/${name}/test/recordings`;
      expect(existsSync(join(root, rec))).toBe(true);
      expect(readdirSync(join(root, rec)).length).toBeGreaterThan(0);
      const pkg = JSON.parse(read(`presets/${name}/package.json`)) as { scripts: Record<string, string> };
      expect(pkg.scripts.test).toContain('vitest run');
    });
  }
});

describe('NFR-1 CI runs ci.sh and the restart script', () => {
  it('NFR-1 a job runs ci.sh and a job runs the restart script', () => {
    const runs = jobRuns();
    const has = (cmd: string) => Object.values(runs).some((r) => r.some((x) => x.trim() === cmd));
    expect(has('bash scripts/ci.sh')).toBe(true);
    expect(has('bash scripts/acceptance/restart.sh')).toBe(true);
  });
});

describe('NFR-18 CI checks the public API reports and runs the semver gate', () => {
  it('NFR-18 ci.sh checks the public API reports and runs the semver gate after build', () => {
    const code = codeLines('scripts/ci.sh');
    expect(code).toMatch(
      /node tooling\/versioning\/api-report\.mjs connector-sdk --check && node tooling\/versioning\/api-report\.mjs config --check && node tooling\/versioning\/semver-gate\.mjs/,
    );
    expect(code.indexOf('semver-gate.mjs')).toBeGreaterThan(code.indexOf('pnpm build'));
    expect(code.indexOf('semver-gate.mjs')).toBeLessThan(code.indexOf('pnpm test\n'));
  });
  it('NFR-18 job ci checks out the full history so the merge base resolves', () => {
    const wf = parse(read('.github/workflows/ci.yml')) as { jobs: Record<string, { steps: { uses?: string; with?: Record<string, unknown> }[] }> };
    const checkout = wf.jobs.ci?.steps.find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });
});
