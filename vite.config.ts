import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

import brand from "./brand.json";

const root = path.dirname(fileURLToPath(import.meta.url));
const logo = path.resolve(root, brand.logo);

/**
 * Branding from brand.json: the page title and the logo. The logo is served
 * and emitted as icon.png next to index.html, so the page, the tray drawing
 * code and the sign-in screen all use one file.
 */
function branding(): Plugin {
  return {
    name: "branding",
    transformIndexHtml: (html) => html.replaceAll("%APP_NAME%", brand.name),
    configureServer(server) {
      server.middlewares.use("/icon.png", (_req, res) => {
        res.setHeader("Content-Type", "image/png");
        res.end(fs.readFileSync(logo));
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "icon.png", source: fs.readFileSync(logo) });
    },
  };
}

export default defineConfig({
  plugins: [react(), branding()],
  // relative paths, so the build opens from a file inside Electron
  base: "./",
  // matrix-js-sdk expects a Node-style global in places
  define: { global: "globalThis" },
  build: {
    // worklets and wasm must stay separate files: Vite would inline small
    // ones as data: URLs, and AudioWorklet cannot load those
    assetsInlineLimit: (file: string) => (/worklet|\.wasm$/i.test(file) ? false : undefined),
    // a desktop app loads its bundle from disk, size warnings do not apply
    chunkSizeWarningLimit: 4000,
  },
  server: {
    port: 5173,
    host: true,
    // build outputs are not watched: the watcher would lock files and make
    // electron-builder fail with EPERM on rename
    watch: { ignored: ["**/release/**", "**/dist/**", "**/native/**"] },
  },
});
