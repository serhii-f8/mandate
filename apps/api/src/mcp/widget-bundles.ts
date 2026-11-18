import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type WidgetKind = 'changeset' | 'approval';

/** MCP Apps resource MIME type (ext-apps `RESOURCE_MIME_TYPE`); written here so `api` needs no ext-apps dependency. */
export const UI_MIME_TYPE = 'text/html;profile=mcp-app';

export const WIDGET_RESOURCES: Readonly<Record<WidgetKind, { uri: string; file: string; name: string; title: string }>> = {
  changeset: { uri: 'ui://aiops/changeset.html', file: 'changeset.html', name: 'changeset', title: 'Change-set' },
  approval: { uri: 'ui://aiops/approval.html', file: 'approval.html', name: 'approval', title: 'Approval' },
};

const KINDS: readonly WidgetKind[] = ['changeset', 'approval'];

export interface WidgetResource {
  kind: WidgetKind;
  uri: string;
  name: string;
  title: string;
  html: string;
}

export interface WidgetCatalog {
  /** Present bundles, in the order changeset, approval. */
  list(): readonly WidgetResource[];
  /** Exact URI match. */
  read(uri: string): WidgetResource | undefined;
  /** Undefined when that bundle is absent. */
  uriFor(kind: WidgetKind): string | undefined;
}

/** The widget directory: `dir` made absolute, or the development location `packages/widgets/dist/ui`. */
export function resolveWidgetDir(dir: string | undefined): string {
  return resolve(dir ?? fileURLToPath(new URL('../../../../packages/widgets/dist/ui', import.meta.url)));
}

export class WidgetBundles implements WidgetCatalog {
  private constructor(private readonly resources: readonly WidgetResource[]) {}

  /** Reads each bundle once; a missing, unreadable or empty file is warned about and left out. */
  static async load(dir: string, warn: (message: string, details: { file: string }) => void): Promise<WidgetBundles> {
    const resources: WidgetResource[] = [];
    for (const kind of KINDS) {
      const { uri, file, name, title } = WIDGET_RESOURCES[kind];
      const path = join(dir, file);
      let html: string | undefined;
      try {
        html = await readFile(path, 'utf8');
      } catch {
        html = undefined; // missing or unreadable: the same text fallback
      }
      if (html === undefined || html.length === 0) {
        warn(`widget bundle missing; ${uri} is not served (set AIOPS_WIDGET_DIR or run pnpm --filter @aiops/widgets build:widgets)`, { file: path });
        continue;
      }
      resources.push({ kind, uri, name, title, html });
    }
    return new WidgetBundles(resources);
  }

  static empty(): WidgetBundles {
    return new WidgetBundles([]);
  }

  list(): readonly WidgetResource[] {
    return this.resources;
  }

  read(uri: string): WidgetResource | undefined {
    return this.resources.find((r) => r.uri === uri);
  }

  uriFor(kind: WidgetKind): string | undefined {
    return this.resources.find((r) => r.kind === kind)?.uri;
  }
}
