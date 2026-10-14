import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Node 18 lacks the File global that undici expects.
if (typeof globalThis.File === "undefined") {
  globalThis.File = class File extends Blob {
    constructor(parts, name, options) {
      super(parts, options);
      this.name = String(name);
    }
  };
}

export default defineConfig({
  css: { postcss: {} }, // hachibi: skip next postcss oxide binding (node18 build env)
  test: {
    environment: "node",
    setupFiles: [resolve(__dirname, "file-polyfill.setup.mjs")],
    globals: true,
    include: ["**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
  },
  resolve: {
    // Use array form so subpath aliases (e.g. "@/lib/db/index.js") resolve correctly.
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      { find: /^@\//, replacement: resolve(__dirname, "../src") + "/" },
    ],
  },
});
