import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app is static: it talks to whatever Fountain the user points it at
// (settings screen), so there is no proxy in the build. In dev the browser
// calls the Fountain origin directly, which needs API_CORS_ORIGINS on that
// server to include http://localhost:5173 — or set FOUNTAIN_PROXY to a
// Fountain URL and the dev server forwards /api there (enter
// http://localhost:5173 as the Fountain URL in the app; paste a key, since
// OAuth redirects go to the real origin).
// `VITE_BASE` is the path the build is served under (GitHub Pages serves a
// project site at /<repo>/); unset means the root.
const proxyTarget = process.env.FOUNTAIN_PROXY?.replace(/\/+$/, "");

// The commit the build was made from, for support reports. GitHub Pages
// builds have GITHUB_SHA; a dev server says "dev".
const appCommit = (process.env.GITHUB_SHA ?? "dev").slice(0, 7);

export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  define: { __APP_COMMIT__: JSON.stringify(appCommit) },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: proxyTarget ? { "/api": { target: proxyTarget, changeOrigin: true, secure: true } } : undefined,
  },
  build: { outDir: "dist", sourcemap: true },
});
