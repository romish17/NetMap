import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Both /api and /ws proxy to the backend — target must be http://
      "/api": {
        target: process.env.VITE_API_URL ?? "http://localhost:3000",
        changeOrigin: true,
      },
      "/ws": {
        target: process.env.VITE_API_URL ?? "http://localhost:3000",
        ws: true,
      },
    },
  },
});
