// Child process: parse + dereference a Swagger 2.0 file, print timing and peak RSS as JSON.
// usage: node parse-schema.mjs <file> [convert]
import { readFileSync } from 'node:fs';
import { dereference, validate } from '@readme/openapi-parser';
import swagger2openapi from 'swagger2openapi';

const file = process.argv[2];
const doConvert = process.argv[3] === 'convert';
const raw = readFileSync(file, 'utf8');
const out = { file, bytes: Buffer.byteLength(raw) };

let t = performance.now();
const doc = JSON.parse(raw);
out.jsonParseMs = Math.round(performance.now() - t);
out.format = doc.swagger ? `swagger ${doc.swagger}` : `openapi ${doc.openapi}`;
out.paths = Object.keys(doc.paths).length;
out.operations = Object.values(doc.paths).reduce((n, p) => n + Object.keys(p).length, 0);
out.definitions = Object.keys(doc.definitions ?? doc.components?.schemas ?? {}).length;

t = performance.now();
const v = await validate(structuredClone(doc));
out.validateMs = Math.round(performance.now() - t);
out.valid = v.valid === true;
if (!out.valid) out.validateErrors = (v.errors ?? []).slice(0, 3).map((e) => e.message);

t = performance.now();
const deref = await dereference(structuredClone(doc));
out.dereferenceMs = Math.round(performance.now() - t);
out.derefPaths = Object.keys(deref.paths).length;
try { out.derefJsonBytes = JSON.stringify(deref).length; } catch (e) { out.derefJsonBytes = `not serialisable: ${e.message.slice(0, 60)}`; }

if (doConvert) {
  t = performance.now();
  const c = await swagger2openapi.convertObj(structuredClone(doc), { patch: true, warnOnly: true });
  out.convertToOas3Ms = Math.round(performance.now() - t);
  out.oas3Version = c.openapi.openapi;
  out.oas3Paths = Object.keys(c.openapi.paths).length;
  out.oas3Schemas = Object.keys(c.openapi.components?.schemas ?? {}).length;
}
const ru = process.resourceUsage();
out.peakRssMB = Math.round(ru.maxRSS / 1024);
console.log(JSON.stringify(out));
