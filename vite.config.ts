import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { pitchRadarApiPlugin } from "./server/vite-plugin";

export default defineConfig({
  plugins: [react(), pitchRadarApiPlugin()],
  server: {
    port: 4182
  },
  preview: {
    port: 4182
  }
});
