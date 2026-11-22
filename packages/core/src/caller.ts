// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/** The identity on whose behalf a request runs. Built from a verified token from Phase 2 on. */
export interface Caller {
  /** Stable user identifier (the token's `sub`, or `anonymous`). */
  readonly subject: string;
  /** OAuth client the request came through, when known. */
  readonly clientId?: string;
  /** Identity-provider groups, mapped to roles by configuration (AUTH-3). */
  readonly groups: readonly string[];
  /** When the user last authenticated (the token's `auth_time`), when the token says so (AUTH-6, APR-8). */
  readonly authTime?: Date;
}

/** The caller of every request until authentication exists (ADR 0013). */
export const ANONYMOUS_CALLER: Caller = Object.freeze({ subject: 'anonymous', groups: Object.freeze([]) });
