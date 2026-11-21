// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The AI Operations Layer Authors
import type { NotificationError } from '@aiops/core';

/** Result of one delivery attempt; a failure carries only a fixed code (SEC-3). */
export type SendOutcome = { readonly ok: true } | { readonly ok: false; readonly error: NotificationError };

/** Plain-text e-mail delivery (NTF-1). */
export interface EmailSender {
  send(mail: { to: readonly string[]; subject: string; text: string }): Promise<SendOutcome>;
  close(): void;
}

/** A configured webhook notification; the URL itself is a secret held in the vault (NTF-1, SEC-2). */
export interface WebhookTarget {
  readonly id: string;
  readonly urlCredentialRef: string;
  readonly allowedHosts: readonly string[];
  readonly allowPrivateNetwork: boolean;
}

/** Webhook delivery behind the egress guard (NTF-1, CONN-5). */
export interface WebhookSender {
  send(target: WebhookTarget, text: string): Promise<SendOutcome>;
}
