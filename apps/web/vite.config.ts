import { defineConfig } from "vite";

const bridge = `http://127.0.0.1:${process.env.AGENTAR_PORT ?? 7777}`;

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": bridge,
      "/models": bridge,
      "/ws": { target: bridge.replace("http", "ws"), ws: true },
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
});
