import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "vite";

/**
 * Development launcher: starts Vite and opens an Electron window pointed at
 * it. Hot reload works as in a browser.
 */

const require = createRequire(import.meta.url);
const electron = require("electron");

const server = await createServer({ server: { port: 5173, strictPort: false } });
await server.listen();

const url = server.resolvedUrls?.local?.[0] ?? "http://localhost:5173/";
console.log(`vite is up at ${url}, opening the window`);

const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, APP_DEV_URL: url },
});

const stop = async (code = 0) => {
  await server.close().catch(() => {});
  process.exit(code);
};

child.on("close", (code) => void stop(code ?? 0));
process.on("SIGINT", () => {
  child.kill();
  void stop(0);
});
