/** Curated operations and manifests for Magento 2 catalog content (preset `preset.yaml`, CONN-8 first cut). */
import { fileURLToPath } from 'node:url';

/** Absolute directory of this preset package (holds `package.json`, `preset.yaml` and `spec/`); same from `src/` and `dist/`. */
export const PRESET_DIR: string = fileURLToPath(new URL('..', import.meta.url));
