import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = `http://127.0.0.1:${process.env.FRIZZ_ZEN_API_PORT ?? 4777}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": api, "/oauth": api },
  },
});
