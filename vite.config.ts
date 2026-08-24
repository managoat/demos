import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app is static: it talks to whatever Fountain the user points it at
// (settings screen). In dev the browser calls that origin directly, which
// needs API_CORS_ORIGINS on the server to include http://localhost:5173.
//
// Against a Fountain whose CORS list you do not control (production), set
// FOUNTAIN_PROXY=https://fountain.example.com and point the app at
// http://localhost:5173 instead: Vite forwards /api and /oauth there.
//
// `VITE_BASE` is the path the build is served under; unset means the root,
// which is where workbench.inevitable.fyi serves it.
const proxyTarget = process.env.FOUNTAIN_PROXY;

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: proxyTarget
      ? {
          "/api": { target: proxyTarget, changeOrigin: true, secure: true },
          "/oauth": { target: proxyTarget, changeOrigin: true, secure: true },
        }
      : undefined,
  },
  build: { outDir: "dist", sourcemap: true },
});
