// CLI: node tooling/security/audit-gate.mjs <audit.json> <allowlist.yaml>  (SEC-11)
import { readFileSync } from 'node:fs';
import { evaluateAudit } from './audit-gate-lib.mjs';

const [auditPath, allowlistPath] = process.argv.slice(2);
if (auditPath === undefined || allowlistPath === undefined) {
  console.error('usage: audit-gate.mjs <audit.json> <allowlist.yaml>');
  process.exit(2);
}

let audit;
try {
  audit = JSON.parse(readFileSync(auditPath, 'utf8'));
} catch {
  audit = undefined;
}
let allowlist;
try {
  allowlist = readFileSync(allowlistPath, 'utf8');
} catch {
  console.error(`cannot read allowlist ${allowlistPath}`);
  process.exit(1);
}

const { exitCode, lines } = evaluateAudit(audit, allowlist, new Date());
for (const line of lines) console.log(line);
console.log(exitCode === 0 ? 'dependency audit gate: pass' : 'dependency audit gate: FAIL');
process.exit(exitCode);
