import type { NewNotification, NotificationKind } from '../approval/model.js';

export type RoleNotifyTargets = ReadonlyMap<
  string,
  { readonly approvalRequests: readonly string[]; readonly results: readonly string[] }
>;

function rows(kind: NotificationKind, targets: readonly string[], round: number, step: number): NewNotification[] {
  return [...new Set(targets)].map((target) => ({ kind, round, step, target }));
}

/** NTF-1: the targets of the role whose approval step became current, deduplicated in order. */
export function approvalRequestNotifications(
  notify: RoleNotifyTargets,
  at: { role: string; round: number; step: number },
): readonly NewNotification[] {
  return rows('approval_requested', notify.get(at.role)?.approvalRequests ?? [], at.round, at.step);
}

/** NTF-1: the result targets of the requesting role; none when the role is unknown. */
export function resultNotifications(
  notify: RoleNotifyTargets,
  at: { kind: 'approval_decided' | 'execution_finished'; role: string | undefined; round: number; step: number },
): readonly NewNotification[] {
  if (at.role === undefined) return [];
  return rows(at.kind, notify.get(at.role)?.results ?? [], at.round, at.step);
}
