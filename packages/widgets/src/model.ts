/** Normalized view models and action interfaces shared by the page and widget entries. */
export type ActionResult<T = undefined> = { ok: true; value: T } | { ok: false; message: string };
export type ItemFilter = 'pending' | 'excluded' | 'written' | 'failed' | 'skipped';
export interface ItemRowModel {
  targetId: string;
  status: string;
  reason?: string;
  before: unknown;
  after: unknown;
  error?: string;
}
export interface ItemsPageModel {
  items: ItemRowModel[];
  next?: string;
}
export interface StatsModel {
  total: number;
  included: number;
  excluded: Record<string, number>;
  written: number;
  failed: number;
  skipped: number;
}
export interface ProgressModel {
  total: number;
  done: number;
  failed: number;
  skipped: number;
}
export interface StepDecisionModel {
  decision: string;
  by: string;
  channel: string;
  ts: string;
  comment?: string;
}
export interface ApprovalStateModel {
  round: number;
  steps: { step: number; role: string; decision?: StepDecisionModel }[];
  awaitingRole?: string;
}
/** `opaque`: a single upstream call with no preview; absent means `diff`. */
export type ChangeSetKind = 'opaque' | 'diff';
export interface ChangeSetViewModel {
  id: string;
  kind?: ChangeSetKind;
  /** The stored arguments of an opaque change-set. */
  args?: Record<string, unknown>;
  operation: { id: string; title?: string };
  status: string;
  hash?: string;
  createdAt: string;
  expiresAt: string;
  stats: StatsModel;
  items: ItemsPageModel;
  itemFilter?: ItemFilter;
  progress?: ProgressModel;
  approval?: ApprovalStateModel;
  drift?: number;
  errorCode?: string;
  derivedFrom?: string;
  rollback: { available: boolean; count?: number; until?: string; stats?: { restored: number; skipped: number; failed: number } };
  pageUrl?: string;
  permissions: { canExclude: boolean; canSubmit: boolean; canCancel: boolean };
}
export interface ApprovalViewModel {
  id: string;
  kind?: ChangeSetKind;
  status: string;
  hash?: string;
  operation: { id: string; title?: string; description?: string; risk?: string };
  request: {
    args: Record<string, unknown>;
    requester: string;
    clientId?: string;
    createdAt: string;
    submittedAt?: string;
  };
  policy?: {
    rule: string;
    role: string;
    approval?: { reason: string; threshold?: number; included: number };
  };
  stats: StatsModel;
  expiresAt: string;
  approval?: ApprovalStateModel;
  sample: { seed: string; items: ItemRowModel[] };
  items: ItemsPageModel;
  itemFilter?: ItemFilter;
  viewer: {
    channel: 'page' | 'widget';
    canDecide: boolean;
    reason: string | null;
    needsFreshLogin: boolean;
    canStart: boolean;
  };
  pageUrl?: string;
  freshLoginUrl?: string;
}
export interface DecisionInput {
  decision: 'approve' | 'reject' | 'return';
  hash: string;
  count: number;
  comment?: string;
}
export interface ChangeSetActions {
  loadItems(q: { after?: string; status?: ItemFilter }): Promise<ActionResult<ItemsPageModel>>;
  refresh(): Promise<ActionResult<ChangeSetViewModel>>;
  exclude?(edit: { exclude: string[]; include: string[] }): Promise<ActionResult<ChangeSetViewModel>>;
  submit?(hash: string): Promise<ActionResult<ChangeSetViewModel>>;
  export?(format: 'csv' | 'xlsx'): Promise<ActionResult>;
  cancel?(): Promise<ActionResult<ChangeSetViewModel>>;
  openPage?(): Promise<ActionResult>;
  /** A value replaces the shown data; none (the widget opened the page) leaves the view as it is. */
  rollback?(): Promise<ActionResult<ChangeSetViewModel | undefined>>;
}
export interface ApprovalActions {
  loadItems(q: { after?: string; status?: ItemFilter }): Promise<ActionResult<ItemsPageModel>>;
  resample(): Promise<ActionResult<{ seed: string; items: ItemRowModel[] }>>;
  decide?(input: DecisionInput): Promise<ActionResult<ApprovalViewModel>>;
  start?(): Promise<ActionResult<ApprovalViewModel>>;
  openPage?(): Promise<ActionResult>;
}

export const TERMINAL_STATUSES: readonly string[] = [
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
  'rolled_back',
  'rejected',
  'expired',
];
export const POLLED_STATUSES: readonly string[] = [
  'preparing',
  'pending_approval',
  'approved',
  'executing',
  'rolling_back',
];
