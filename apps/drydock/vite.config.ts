import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser talks only to the Drydock server (server/), same origin. It
// never reaches Fountain, GitHub or Sprites directly and holds no credential
// for any of them — see shared/api.ts for why that wall is where it is.
//
// In dev, Vite serves the SPA and forwards the API to the server:
//
//   bun run mock                                   a fake Fountain on :8793
//   FOUNTAIN_URL=http://localhost:8793 bun run server
//   bun run dev                                    this, on :5183
const server = process.env.DRYDOCK_SERVER ?? "http://localhost:8081";
const appCommit = (process.env.GITHUB_SHA ?? "dev").slice(0, 7);

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  define: { __APP_COMMIT__: JSON.stringify(appCommit) },
  plugins: [react()],
  server: {
    port: 5183,
    proxy: {
      // `ws: true` is what makes the terminal work in development: the PTY
      // rides a WebSocket under /api, and a proxy that forwards only HTTP
      // answers the upgrade with a 200 and no explanation of why nothing
      // connected.
      "/api": { target: server, changeOrigin: false, ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
