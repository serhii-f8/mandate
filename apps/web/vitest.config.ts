// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import react from '@vitejs/plugin-react';
import { packageConfig } from '../../vitest.shared.ts';

export default packageConfig({ plugins: [react()], unitEnvironment: 'jsdom' });
