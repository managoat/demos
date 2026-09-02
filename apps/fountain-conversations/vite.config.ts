import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app is static: it talks to whatever Fountain the user points it at
// (settings screen), so there is no proxy here. In dev the browser calls the
// Fountain origin directly, which needs API_CORS_ORIGINS on that server to
// include http://localhost:5173.
// `VITE_BASE` is the path the build is served under (GitHub Pages serves a
// project site at /<repo>/); unset means the root.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: "dist", sourcemap: true },
});
