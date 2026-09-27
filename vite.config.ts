import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

import brand from "./brand.json" with { type: "json" };

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

/**
 * Content Security Policy of the built page. Scripts run only from the app's
 * own files (and WebAssembly, which the crypto and noise suppression need);
 * nothing inline, nothing from the network. Connections may go anywhere over
 * http(s) and websockets: homeservers and media servers are the user's
 * choice. Frames: the YouTube player only. The development server gets no
 * policy, its hot reload injects inline scripts.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob: mediastream:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: http: ws: blob: data:",
  "frame-src https://www.youtube-nocookie.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function contentSecurity(): Plugin {
  return {
    name: "content-security",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  plugins: [react(), branding(), contentSecurity()],
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
    // this machine only: a development server open to the network would hand
    // the source and, through its file access, more than that to anyone nearby
    host: "localhost",
    // build outputs are not watched: the watcher would lock files and make
    // electron-builder fail with EPERM on rename
    watch: { ignored: ["**/release/**", "**/dist/**", "**/native/**"] },
  },
});
