// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
/**
 * The structured content the widget reads (design part 3 §3.2 and §4). Answers are untrusted
 * input: every schema is used with `safeParse`, and unknown fields are ignored (UI-1).
 */
import { z } from 'zod';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const uuidSchema = z.string().regex(UUID);

/** Only an absolute http(s) address is a page link; anything else counts as absent (SEC-5). */
export function isPageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === 'https:' || protocol === 'http:';
}
const pageUrlSchema = z.unknown().transform((v) => (isPageUrl(v) ? v : undefined));

export const itemSchema = z.object({
  targetId: z.string(),
  status: z.string(),
  reason: z.string().optional(),
  before: z.unknown(),
  after: z.unknown(),
  error: z.string().optional(),
  verificationStatus: z.enum(['pending', 'confirmed', 'unconfirmed']).optional(),
  verificationCode: z.string().optional(),
});

export const statsSchema = z.object({
  total: z.number(),
  included: z.number(),
  excluded: z.record(z.string(), z.number()),
  written: z.number(),
  failed: z.number(),
  skipped: z.number(),
  verification: z.object({ pending: z.number(), confirmed: z.number(), unconfirmed: z.number() }).optional(),
});

const progressSchema = z.object({ total: z.number(), done: z.number(), failed: z.number(), skipped: z.number() });

/** CS-9, UI-4: the plan block of `get_changeset` and of the review detail; `visible` is on the detail only and unused here. */
const planSchema = z.object({
  id: z.string(),
  title: z.string(),
  step: z.number(),
  of: z.number(),
  steps: z.array(z.object({ step: z.number(), id: z.string(), operation: z.string(), status: z.string(), visible: z.boolean().optional() })),
  /** EXE-13: absent in answers from before this field and when there is nothing to say. */
  startLine: z.string().optional(),
});

/** APR-5, CS-10: a file the call sends; the server's page detail and the MCP answers describe it the same way. */
export const fileRowSchema = z.object({
  pointer: z.string(),
  id: z.string(),
  name: z.string(),
  mediaType: z.string(),
  size: z.number(),
  sha256: z.string(),
  preview: z.enum(['image', 'text', 'none']),
  available: z.boolean(),
});

/** Today `get_changeset` sends the operation ID as a string; an object with a title is read too (ruling F13). */
const operationSchema = z
  .union([z.string(), z.object({ id: z.string(), title: z.string().optional() })])
  .transform((op) => (typeof op === 'string' ? { id: op } : op));

/** `get_changeset`, the prepared result and `exclude_changeset_items` (changeset-tools.ts, result.ts, exclude-tool.ts). */
export const changeSetAnswerSchema = z.object({
  changeset: z.object({
    id: uuidSchema,
    operation: operationSchema,
    status: z.string(),
    hash: z.string().optional(),
    stats: statsSchema,
    createdAt: z.string(),
    expiresAt: z.string(),
    errorCode: z.string().optional(),
    kind: z.enum(['opaque', 'diff']).optional(),
    action: z.enum(['update', 'create', 'delete']).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  progress: progressSchema.optional(),
  approval: z
    .object({
      round: z.number(),
      plan: z.object({ steps: z.array(z.string()) }),
      decisions: z.array(
        z.object({
          step: z.number(),
          approver: z.string(),
          decision: z.string(),
          channel: z.string(),
          ts: z.string(),
          comment: z.string().optional(),
        }),
      ),
    })
    .optional(),
  items: z.array(itemSchema),
  nextCursor: z.string().optional(),
  derivedFrom: z.string().optional(),
  rollback: z
    .object({
      available: z.boolean(),
      count: z.number().int().optional(),
      until: z.string().optional(),
      stats: z.object({ restored: z.number(), skipped: z.number(), failed: z.number() }).optional(),
    })
    .optional(),
  execution: z.object({ drift: z.number() }).optional(),
  /** EXE-12: absent unless the change-set was verified. */
  verificationTitles: z.record(z.string(), z.string()).optional(),
  /** CS-9: absent for a change-set outside a plan, and in answers from before 1.3.0. */
  plan: planSchema.optional(),
  /** CS-10: absent unless the call sends files. */
  files: z.array(fileRowSchema).optional(),
  pageUrl: pageUrlSchema,
});

/** The page detail block inside the `review_changeset` answer (apps/api/src/approvals/detail.ts). */
const detailSchema = z.object({
  id: uuidSchema,
  status: z.string(),
  hash: z.string().optional(),
  kind: z.enum(['opaque', 'diff']).optional(),
  action: z.enum(['update', 'create', 'delete']).optional(),
  /** CS-3: absent in answers from before 1.2.0. */
  reasonTitles: z.record(z.string(), z.string()).optional(),
  plan: planSchema.optional(),
  /** CS-10: absent unless the call sends files. */
  files: z.array(fileRowSchema).optional(),
  operation: z.object({ id: z.string(), title: z.string().optional(), description: z.string().optional(), risk: z.string().optional() }),
  request: z.object({
    args: z.record(z.string(), z.unknown()),
    requester: z.string(),
    clientId: z.string().optional(),
    createdAt: z.string(),
    submittedAt: z.string().optional(),
  }),
  policy: z
    .object({
      rule: z.string(),
      role: z.string(),
      approval: z.object({ reason: z.string(), threshold: z.number().optional(), included: z.number() }).optional(),
    })
    .optional(),
  stats: statsSchema,
  expiresAt: z.string(),
  approval: z
    .object({
      round: z.number(),
      steps: z.array(
        z.object({
          step: z.number(),
          role: z.string(),
          decision: z
            .object({
              approver: z.string(),
              name: z.string().optional(),
              decision: z.string(),
              channel: z.string(),
              comment: z.string().optional(),
              ts: z.string(),
            })
            .optional(),
        }),
      ),
      awaitingRole: z.string().optional(),
    })
    .optional(),
  viewer: z.object({ canDecide: z.boolean(), reason: z.string().nullable() }),
});

/** `review_changeset` (ADR 0036 R19); `changesetId` is ignored. */
export const reviewAnswerSchema = z.object({
  detail: detailSchema,
  items: z.array(itemSchema),
  nextCursor: z.string().optional(),
  sample: z.object({ seed: z.string(), items: z.array(itemSchema) }),
  pageUrl: pageUrlSchema,
});

export type ChangeSetAnswer = z.infer<typeof changeSetAnswerSchema>;
export type ReviewAnswer = z.infer<typeof reviewAnswerSchema>;
export type ItemAnswer = z.infer<typeof itemSchema>;
