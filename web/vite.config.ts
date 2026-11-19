import { fileURLToPath } from "node:url";
import { astryxStylex } from "@astryxdesign/build/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The admin page: a React app built with Astryx (Meta's design system on StyleX).
// `npm run build:web` writes it to public/, which the server serves; `npm run dev:web`
// serves it on :5173 with the admin API proxied to the server on :8080.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [...astryxStylex(), react()],
  build: {
    outDir: fileURLToPath(new URL("../public", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080" },
  },
});
