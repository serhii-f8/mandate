// One config, four single-file builds selected by TARGET:
//   widget  -> dist/widget/widget.html   (MCP Apps UI resource, ui://changeset/preview.html)
//   page    -> dist/page/page.html       (served at GET /changesets/:id)
//   host    -> dist/host/host/index.html (minimal host around vendored basic-host code)
//   sandbox -> dist/host/host/sandbox.html (outer sandbox proxy, other origin)
// Pattern from ext-apps v2.0.4 examples/basic-server-react/vite.config.ts.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

const inputs = {
  widget: { input: "widget.html", outDir: "dist/widget" },
  page: { input: "page.html", outDir: "dist/page" },
  host: { input: "host/index.html", outDir: "dist/host" },
  sandbox: { input: "host/sandbox.html", outDir: "dist/host" },
};
const target = inputs[process.env.TARGET ?? ""];
if (!target) throw new Error("TARGET must be one of " + Object.keys(inputs).join(", "));

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  logLevel: "warn",
  build: {
    rollupOptions: { input: target.input },
    outDir: target.outDir,
    emptyOutDir: false,
    minify: true,
  },
});
