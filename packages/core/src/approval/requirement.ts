import type { RiskClass } from '../policy-model.js';
import {
  DEFAULT_STEP_UP_SECONDS,
  type ApprovalReason,
  type ApprovalRequirement,
  type RoleApprovalRule,
} from './model.js';

/**
 * Whether a change-set needs human approval, and from whom (POL-5). First match of:
 * destructive risk, `never`, `above_threshold`, `always`, no rule. Under `above_threshold` an
 * opaque operation (`isOpaque`) is required with reason `opaque`: its one call has no record
 * count a threshold could compare. A required result without steps is unroutable.
 */
export function approvalRequirement(input: {
  risk: RiskClass;
  /** `isOpaque(operation)`; a caller that cannot find the operation passes true. */
  opaque: boolean;
  rule?: RoleApprovalRule;
  included: number;
}): ApprovalRequirement {
  const { risk, rule, included } = input;
  const destructive = risk === 'destructive';

  let reason: ApprovalReason;
  if (destructive) {
    reason = 'risk_destructive';
  } else if (rule?.required === 'never') {
    return { required: false };
  } else if (rule?.required === 'above_threshold') {
    if (input.opaque) reason = 'opaque';
    else if (included <= (rule.recordThreshold ?? 0)) return { required: false };
    else reason = 'above_threshold';
  } else if (rule?.required === 'always') {
    reason = 'role_always';
  } else {
    reason = 'default';
  }

  const steps = rule?.steps ?? [];
  if (steps.length === 0) return { required: true, unroutable: true, reason };

  const stepUpSeconds = rule?.stepUpMaxAgeSeconds ?? (destructive ? DEFAULT_STEP_UP_SECONDS : undefined);
  return {
    required: true,
    reason,
    steps,
    ...(stepUpSeconds !== undefined ? { stepUp: { maxAgeSeconds: stepUpSeconds } } : {}),
    widget: !destructive && (rule?.allowWidget ?? false) && stepUpSeconds === undefined,
    ...(reason === 'above_threshold' && rule?.recordThreshold !== undefined
      ? { threshold: rule.recordThreshold }
      : {}),
    included,
  };
}
