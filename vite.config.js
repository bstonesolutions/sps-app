import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, existsSync } from "fs";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "copy-root-assets",
      writeBundle() {
        const files = ["icon-180.png","icon-192.png","icon-512.png","favicon.png","manifest.webmanifest"];
        files.forEach(f => { if (existsSync(f)) copyFileSync(f, "dist/" + f); });
      },
    },
  ],
});
