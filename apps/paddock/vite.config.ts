import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser talks only to the Paddock server (server/), same origin: its own
// API under /api and Fountain-through-a-machine under /f. It never reaches
// Fountain directly and never holds a key — see server/proxy.ts.
//
// In dev, Vite serves the SPA and forwards both to the server:
//
//   bun run mock                                   a fake Fountain on :8792
//   FOUNTAIN_URL=http://localhost:8792 bun run server
//   bun run dev                                    this, on :5182
//
// VITE_BASE is the path the build is served under; unset means the root.
const server = process.env.PADDOCK_SERVER ?? "http://localhost:8080";
const appCommit = (process.env.GITHUB_SHA ?? "dev").slice(0, 7);

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  define: { __APP_COMMIT__: JSON.stringify(appCommit) },
  plugins: [react()],
  server: {
    port: 5182,
    proxy: {
      "/api": { target: server, changeOrigin: false },
      "/f": { target: server, changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
