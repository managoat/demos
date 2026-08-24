import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser talks only to the workbench server (server/), same origin: its
// own API under /api and Fountain-through-a-project under /f. In dev, Vite
// serves the SPA and forwards both to the server (`bun run server`, :8080).
//
// `VITE_BASE` is the path the build is served under; unset means the root,
// which is where workbench.inevitable.fyi serves it.
const server = process.env.WORKBENCH_SERVER ?? "http://localhost:8080";

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: server, changeOrigin: false },
      "/f": { target: server, changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
