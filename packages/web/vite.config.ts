import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    proxy: {
      "/ws": { target: process.env.KUSAL_DEV_API ?? "ws://localhost:7681", ws: true, changeOrigin: true },
      "/api": { target: process.env.KUSAL_DEV_API ?? "http://localhost:7681", changeOrigin: true },
    },
  },
  build: { outDir: "dist" },
});
