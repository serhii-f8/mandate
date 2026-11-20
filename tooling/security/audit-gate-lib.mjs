// Dependency audit gate (SEC-11). Pure logic: no file or process access, so tests can import it.
import { parse } from 'yaml';

const GATED = new Set(['high', 'critical']);
const MAX_DAYS = 90;
const DAY_MS = 86_400_000;

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function dayNumber(date) {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / DAY_MS);
}

/** Parses an ISO date (YYYY-MM-DD) to a day number, or undefined when it is not a real date. */
function isoDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return undefined;
  return dayNumber(d);
}

function readAllowlist(allowlist) {
  const text = typeof allowlist === 'string' ? allowlist : '';
  let doc;
  try {
    doc = typeof allowlist === 'string' ? parse(text) : allowlist;
  } catch {
    return { errors: ['malformed allowlist: not valid YAML'] };
  }
  if (doc === null || doc === undefined) doc = [];
  if (!Array.isArray(doc)) return { errors: ['malformed allowlist: top level must be a list'] };
  const errors = [];
  const entries = [];
  doc.forEach((e, i) => {
    if (!isRecord(e)) {
      errors.push(`malformed allowlist: entry ${i} is not a mapping`);
      return;
    }
    let ok = true;
    for (const field of ['id', 'package', 'reason', 'expires']) {
      const v = e[field];
      if (typeof v !== 'string' || v.trim() === '') {
        errors.push(`malformed allowlist: entry ${i} field "${field}" is missing or not a non-empty string`);
        ok = false;
      }
    }
    if (ok && isoDay(e.expires) === undefined) {
      errors.push(`malformed allowlist: entry ${i} field "expires" must be a date as YYYY-MM-DD`);
      ok = false;
    }
    if (ok) entries.push({ id: e.id, package: e.package, reason: e.reason, expires: e.expires });
  });
  return { errors, entries };
}

function readAdvisories(audit) {
  if (!isRecord(audit) || !isRecord(audit.advisories)) return undefined;
  const out = [];
  for (const adv of Object.values(audit.advisories)) {
    if (!isRecord(adv)) return undefined;
    const { github_advisory_id: id, module_name: pkg, severity } = adv;
    if (typeof id !== 'string' || typeof pkg !== 'string' || typeof severity !== 'string') return undefined;
    const findings = Array.isArray(adv.findings) ? adv.findings : [];
    const paths = findings.flatMap((f) => (isRecord(f) && Array.isArray(f.paths) ? f.paths.filter((p) => typeof p === 'string') : []));
    out.push({ id, pkg, severity, paths });
  }
  return out;
}

/**
 * @param {unknown} audit parsed `pnpm audit --json` output
 * @param {unknown} allowlist YAML text (or an already parsed list) of allowlist entries
 * @param {Date} today the run date
 * @returns {{ exitCode: 0 | 1; lines: string[] }}
 */
export function evaluateAudit(audit, allowlist, today) {
  const advisories = readAdvisories(audit);
  if (advisories === undefined) return { exitCode: 1, lines: ['unreadable audit report'] };
  const { errors, entries } = readAllowlist(allowlist);
  if (errors.length > 0) return { exitCode: 1, lines: errors };

  const lines = [];
  let failed = false;
  const todayNum = dayNumber(today);
  const byId = new Map(entries.map((e) => [e.id, e]));
  const seen = new Set(advisories.map((a) => a.id));

  for (const e of entries) {
    const exp = isoDay(e.expires);
    if (exp < todayNum) {
      lines.push(`expired allowlist entry ${e.id} (${e.package}) expired ${e.expires}`);
      failed = true;
    } else if (exp - todayNum > MAX_DAYS) {
      lines.push(`allowlist entry ${e.id} (${e.package}) expires ${e.expires}, more than ${MAX_DAYS} days away`);
      failed = true;
    }
    if (!seen.has(e.id)) {
      lines.push(`stale allowlist entry ${e.id} (${e.package}): no current advisory matches`);
      failed = true;
    }
  }

  for (const a of advisories) {
    const entry = byId.get(a.id);
    const where = `${a.id} ${a.pkg} ${a.severity} ${a.paths[0] ?? '(no path)'}`;
    if (entry !== undefined) {
      lines.push(`allowed ${a.id} until ${entry.expires} (${a.pkg}, ${a.severity})`);
    } else if (GATED.has(a.severity)) {
      lines.push(`blocked ${where}`);
      failed = true;
    } else {
      lines.push(`not gated ${where}`);
    }
  }
  return { exitCode: failed ? 1 : 0, lines };
}
