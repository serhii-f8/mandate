/**
 * SEC-11: every denial path of SPEC section 5.3 with the test that proves it. Codes are the names
 * as built (`pending_approval`, not `approval_required`). The completeness test next to
 * `src/security` checks the codes against core and the titles against the files.
 */
export interface DenialPath {
  readonly id: string;
  readonly requirement: 'MCP-3' | 'POL-1' | 'POL-2' | 'POL-3' | 'POL-4' | 'POL-5' | 'POL-6' | 'POL-7' | 'POL-8' | 'SEC-10';
  readonly code: string;
  readonly surface: 'mcp' | 'page' | 'worker' | 'cli';
  readonly test: { readonly file: string; readonly title: string };
}

const DENIALS = 'apps/api/test/e2e/security-denials.e2e.test.ts';
const RATE = 'apps/api/test/e2e/rate-limits.e2e.test.ts';
const CLI = 'apps/api/src/cli-config.test.ts';

export const DENIAL_PATHS: readonly DenialPath[] = [
  { id: 'MCP-3/invalid_arguments', requirement: 'MCP-3', code: 'invalid_arguments', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 MCP-3 invalid_arguments are refused before policy' } },
  { id: 'POL-1/unknown_tool', requirement: 'POL-1', code: 'unknown_tool', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-1 unknown_tool: an ungranted tool is not listed and its call is refused as unknown' } },
  { id: 'POL-1/no_grant', requirement: 'POL-1', code: 'no_grant', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-1 no_grant: an existing ungranted tool is refused over MCP with default-deny' } },
  { id: 'POL-1/no_grant/cli', requirement: 'POL-1', code: 'no_grant', surface: 'cli', test: { file: CLI, title: 'CFG-3 POL-7 config explain exits 0 for allow, 1 for deny, 2 for usage' } },
  { id: 'POL-2/out_of_scope', requirement: 'POL-2', code: 'out_of_scope', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-2 out_of_scope' } },
  { id: 'POL-2/scope_argument_missing', requirement: 'POL-2', code: 'scope_argument_missing', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-2 scope_argument_missing' } },
  { id: 'POL-3/denied_field', requirement: 'POL-3', code: 'denied_field', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-3 denied_field' } },
  { id: 'POL-3/field_not_allowed', requirement: 'POL-3', code: 'field_not_allowed', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-3 field_not_allowed' } },
  { id: 'POL-4/limit_exceeded/calls_per_minute', requirement: 'POL-4', code: 'limit_exceeded/calls_per_minute', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-4 limit_exceeded/calls_per_minute' } },
  { id: 'POL-4/limit_exceeded/records_per_operation', requirement: 'POL-4', code: 'limit_exceeded/records_per_operation', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-4 limit_exceeded/records_per_operation' } },
  { id: 'POL-4/limit_exceeded/records_per_day', requirement: 'POL-4', code: 'limit_exceeded/records_per_day', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-4 limit_exceeded/records_per_day' } },
  { id: 'POL-4/limit_exceeded/concurrent_executions', requirement: 'POL-4', code: 'limit_exceeded/concurrent_executions', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-4 limit_exceeded/concurrent_executions' } },
  { id: 'POL-5/pending_approval', requirement: 'POL-5', code: 'pending_approval', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-5 pending_approval: a change-set above the threshold does not execute' } },
  { id: 'POL-5/not_approved', requirement: 'POL-5', code: 'not_approved', surface: 'page', test: { file: DENIALS, title: 'SEC-11 POL-5 not_approved: the page start route refuses without approval rows' } },
  { id: 'POL-5/approval_unroutable', requirement: 'POL-5', code: 'approval_unroutable', surface: 'mcp', test: { file: 'apps/api/src/mcp/submit-tool.test.ts', title: 'POL-5 a role with required approval but no steps in the snapshot answers approval_unroutable and stays prepared' } },
  { id: 'POL-6/policy_denied/submit', requirement: 'POL-6', code: 'policy_denied', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-6 a role removed after preparation is refused at submit' } },
  { id: 'POL-6/policy_denied/worker', requirement: 'POL-6', code: 'policy_denied', surface: 'worker', test: { file: 'apps/worker/test/integration/guard.int.test.ts', title: 'POL-6 the production guard denies when the stored groups no longer grant the operation and audits the decision' } },
  { id: 'POL-7/dry_deny', requirement: 'POL-7', code: 'dry_deny', surface: 'cli', test: { file: CLI, title: 'CFG-3 POL-7 config explain writes no audit row and no revision' } },
  { id: 'POL-8/audit', requirement: 'POL-8', code: 'audit', surface: 'mcp', test: { file: DENIALS, title: 'SEC-11 POL-8 an MCP denial ($reason) writes exactly one policy.decision row naming its rule' } },
  { id: 'SEC-10/rate_limited/user', requirement: 'SEC-10', code: 'rate_limited/user', surface: 'mcp', test: { file: RATE, title: 'SEC-10 SEC-11 the fourth request of a user in a minute gets 429 with Retry-After and the JSON-RPC error' } },
  { id: 'SEC-10/rate_limited/service_account', requirement: 'SEC-10', code: 'rate_limited/service_account', surface: 'mcp', test: { file: RATE, title: 'SEC-10 SEC-11 a service account uses its override' } },
  { id: 'SEC-10/rate_limited/anonymous', requirement: 'SEC-10', code: 'rate_limited/anonymous', surface: 'mcp', test: { file: RATE, title: 'SEC-10 SEC-1 anonymous requests over the limit get 429 and write no auth.rejected row' } },
  { id: 'SEC-10/rate_limit_unavailable', requirement: 'SEC-10', code: 'rate_limit_unavailable', surface: 'mcp', test: { file: 'apps/api/src/http/rate-limiter.test.ts', title: 'SEC-10 fails closed when the counter throws' } },
];
