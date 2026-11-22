# ADR 0010: Toolchain and workspace layout

- Status: Accepted
- Date: 2026-11-16

## Context

Phase 1 sets up the pnpm + Turborepo monorepo of [SPEC](../SPEC.md) section 3. During Phase 0
`pnpm` could not be run through corepack on the development machine (see Verified), and the
Phase 0 experiments used npm. Several version choices interact: the TypeScript release,
typescript-eslint, NestJS 12's module format, Vitest and decorator metadata.

## Options considered

1. **pnpm:** (a) repair corepack globally (a change to machine configuration, outside the
   repository); (b) install pnpm globally with npm (same); (c) pin a version corepack can run
   in `packageManager`. Chosen (c).
2. **TypeScript:** 7.0.2 (native) or 6.0.3. typescript-eslint is required for the
   type-aware lint rules and the boundary rules; chosen 6.0.3.
3. **Module format:** CommonJS with interop, or ESM throughout. NestJS 12, the MCP SDK
   v2 and ext-apps are ESM-only; chosen ESM throughout (`"type": "module"`,
   `module`/`moduleResolution` `nodenext`).
4. **Cross-package resolution:** build-first, project references, or a custom
   export condition. Chosen: condition `@mandate/source` → `src/*.ts` for
   type-check and Vitest, `types`/`default` → `dist` for build and runtime.
5. **Boundary enforcement:** `eslint-plugin-boundaries`, dependency-cruiser, or ESLint's
   built-in `no-restricted-imports` with per-directory overrides. Chosen the built-in
   rule plus a test that lints violating samples and a manifest test for `packages/core`:
   no extra dependency, and the rule is proven to fire.
6. **Decorators under Vitest:** NestJS constructor injection relies on
   `emitDecoratorMetadata`; Vitest's default transform does not emit it. Chosen
   `unplugin-swc` for the `api` test projects only; `tsc` emits metadata for the build.
7. **Node:** 22 (maintenance LTS, verified by the Phase 0 experiments) or 24
   (active LTS). Chosen 22.12+ for Phase 1; moving to 24 is a one-line change in
   `.nvmrc`, `engines` and the Dockerfile and is left for Phase 10.
8. **Package scope:** `@mandate/*`.

## Decision

pnpm 11.28.12 through `packageManager`; Turborepo 2.11; TypeScript 6.0.3 with
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`; ESLint 10 flat config with typescript-eslint 8.73; Vitest 5 with
one root config listing unit, integration and e2e projects by file suffix; pino for
structured JSON logs; Zod 4 for environment and input parsing; ESM throughout;
`@mandate/source` export condition; Node `^22.12`.

## Consequences

- `pnpm` works in this repository without changing machine configuration. Upgrading past
  pnpm 11 needs a corepack that knows pnpm 12's `bin/pnpm.mjs` layout.
- TypeScript 7 is not used until typescript-eslint supports it.
- Every package's `tsconfig.build.json` must omit the source condition, or `tsc` would
  pull sibling sources into its program.

## Verified

2026-11-16, on the development machine:

- `pnpm -v` in a directory whose `package.json` has `"packageManager": "pnpm@12.21.0"`
  fails under corepack 0.34.0 (Node v22.20.0); the cached 12.9.1 record
  `~/.cache/node/corepack/v1/pnpm/12.9.1/.corepack` names `./bin/pnpm.cjs` while the
  package contains only `bin/pnpm.mjs`. With `"packageManager": "pnpm@11.28.12"`
  corepack downloads it and `pnpm -v` prints `11.28.12`.
- `npm view typescript-eslint@8.73.0 peerDependencies` →
  `typescript: '>=4.8.4 <6.1.0'`; latest TypeScript releases 6.0.3 and 7.0.2.
- `npm view @nestjs/core@12.5.0 type` → `module`; `@modelcontextprotocol/server@2.4.0`
  → `module`; `vitest@5.1.0` engines `node: '^22.12.0 || ^24.0.0 || >=26.0.0'`.

## Addendum 2026-11-16: dependency build scripts and pnpm supply-chain policy

- **Dependency build scripts.** pnpm 11 defaults to `strictDepBuilds`, so a
  non-interactive install (Docker build, CI) fails with `ERR_PNPM_IGNORED_BUILDS` while
  any dependency build script is undecided (observed in `docker build`). The decision is
  recorded in [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) under `allowBuilds`:
  `@swc/core`, `cpu-features`, `esbuild`, `protobufjs` and `ssh2` are denied. Each ships its
  binaries as optional platform packages, has an optional native fallback, or only prints a
  notice; the full test suite, both images and the Compose stack run without them. A new
  dependency with a build script must be decided there explicitly.
- **pnpm 11 supply-chain policy.** `minimumReleaseAge` is on by default; pnpm wrote
  `minimumReleaseAgeExclude` entries for the typescript-eslint 8.73.0 packages, which
  were newer than the threshold. They are kept, pinned to that exact version.
