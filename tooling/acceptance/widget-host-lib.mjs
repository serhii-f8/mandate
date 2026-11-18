// Pure helpers of the reference host (widget-host.mjs and the host page).
export const MCP_APPS_DEFAULT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";
export const HOST_THEME = { '--color-background-primary': 'rgb(1, 2, 3)', '--color-text-primary': 'rgb(250, 251, 252)' };
export const TERMINAL = new Set(['completed', 'completed_with_errors', 'failed', 'cancelled', 'expired', 'rolled_back']);

const USAGE =
  'usage: widget-host.mjs <mcp-url> list | render --tool NAME [--args JSON] [--exclude N] [--submit] [--decide approve] [--open-page] [--wait-terminal S]';

const fail = () => {
  throw new Error(USAGE);
};
const count = (value) => {
  if (!/^\d+$/.test(value ?? '')) fail();
  return Number(value);
};

export function parseArgs(argv) {
  const [url, command, ...rest] = argv;
  if (url === undefined || (command !== 'list' && command !== 'render')) fail();
  const out = { url, command };
  if (command === 'list') {
    if (rest.length > 0) fail();
    return out;
  }
  out.args = {};
  for (let i = 0; i < rest.length; i++) {
    switch (rest[i]) {
      case '--tool':
        out.tool = rest[++i];
        if (out.tool === undefined) fail();
        break;
      case '--args':
        try {
          out.args = JSON.parse(rest[++i] ?? '');
        } catch {
          fail();
        }
        if (typeof out.args !== 'object' || out.args === null || Array.isArray(out.args)) fail();
        break;
      case '--exclude':
        out.exclude = count(rest[++i]);
        break;
      case '--wait-terminal':
        out.waitTerminal = count(rest[++i]);
        break;
      case '--submit':
        out.submit = true;
        break;
      case '--open-page':
        out.openPage = true;
        break;
      case '--decide':
        if (rest[++i] !== 'approve') fail();
        out.decide = 'approve';
        break;
      default:
        fail();
    }
  }
  if (out.tool === undefined) fail();
  return out;
}
