// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import swc from 'unplugin-swc';
import { packageConfig } from '../../vitest.shared.ts';

// NestJS constructor injection needs decorator metadata, which Vitest's default
// transform does not emit; SWC does (ADR 0010).
export default packageConfig({
  plugins: [swc.vite({ jsc: { parser: { syntax: 'typescript', decorators: true }, transform: { legacyDecorator: true, decoratorMetadata: true } } })],
});
