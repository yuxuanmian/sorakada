/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Set by the Tauri CLI when developing against a device on the local network.
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  build: {
    rollupOptions: {
      output: {
        // CodeMirror and the React runtime are both large and change
        // independently of the application code, so each gets its own chunk.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (
            id.includes("codemirror") ||
            id.includes("@lezer") ||
            id.includes("style-mod") ||
            id.includes("w3c-keyname") ||
            id.includes("crelt")
          ) {
            return "codemirror";
          }
          return "vendor";
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Vitest only picks up the pure TypeScript lifecycle/command tests. The
  // production Vite pipeline above is untouched: browser/native behaviour is
  // validated manually with `specs/001-single-file-editing/quickstart.md`.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
