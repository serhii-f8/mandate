// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import type { ReactElement } from 'react';
import type { PlanModel } from '../model.js';
import { StatusBadge } from './StatusBadge.js';

/**
 * UI-4, APR-5, CS-9, EXE-13: the plan a change-set belongs to, its steps and what this step waits for. The title
 * is a requester's text and renders as text only (SEC-5). A step is a link only when the answer gave it one,
 * which the server does for the steps the viewer may open; the line about the start (`Runs after ...`,
 * `Blocked: ...`, `Ready to start`) is worded by the server too: the browser decides nothing.
 */
export function PlanSection({ plan }: { plan: PlanModel | undefined }): ReactElement | null {
  if (plan === undefined) return null;
  const waiting = plan.startLine;
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
