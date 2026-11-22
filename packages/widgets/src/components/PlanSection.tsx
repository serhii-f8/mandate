// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ReactElement } from 'react';
import type { PlanModel } from '../model.js';
import { StatusBadge } from './StatusBadge.js';

/** CS-9, EXE-13: what a step above 1 waits for, while the step before it is not `completed`. */
function waitingLine(plan: PlanModel): string | undefined {
  if (plan.step <= 1) return undefined;
  const before = plan.steps.find((s) => s.step === plan.step - 1);
  if (before === undefined || before.status === 'completed') return undefined;
  return `Runs after step ${String(before.step)} completes (now: ${before.status})`;
}

/**
 * UI-4, APR-5, CS-9: the plan a change-set belongs to, its steps and what this step waits for. The title is a
 * requester's text and renders as text only (SEC-5). A step is a link only when the answer gave it one, which
 * the server does for the steps the viewer may open; the browser decides nothing.
 */
export function PlanSection({ plan }: { plan: PlanModel | undefined }): ReactElement | null {
  if (plan === undefined) return null;
  const waiting = waitingLine(plan);
  return (
    <section className="plan" aria-label="Plan">
      <p>{`Step ${String(plan.step)} of ${String(plan.of)} in plan "${plan.title}"`}</p>
      {waiting === undefined ? null : <p className="waiting">{waiting}</p>}
      <ol>
        {plan.steps.map((s) => (
          <li key={s.step} aria-current={s.step === plan.step ? 'step' : undefined}>
            <span>{String(s.step)}</span> {s.href === undefined ? <span>{s.operation}</span> : <a href={s.href}>{s.operation}</a>}{' '}
            <StatusBadge status={s.status} />
          </li>
        ))}
      </ol>
    </section>
  );
}
