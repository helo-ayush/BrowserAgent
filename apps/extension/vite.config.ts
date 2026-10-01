import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import path from "node:path";
import manifest from "./src/manifest";

export default defineConfig({
  root: path.resolve(process.cwd(), "apps/extension"),
  plugins: [react(), crx({ manifest })],
  server: { port: 5173, strictPort: true },
});
