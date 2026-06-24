import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, existsSync, mkdirSync } from "fs";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "copy-root-assets",
      writeBundle() {
        const files = ["icon-180.png","icon-192.png","icon-512.png","favicon.png","manifest.webmanifest"];
        files.forEach(f => { if (existsSync(f)) copyFileSync(f, "dist/" + f); });
        // Apple App Site Association — enables iOS password autofill (webcredentials)
        // for the native app. Must be served at /.well-known/apple-app-site-association.
        if (existsSync(".well-known/apple-app-site-association")) {
          mkdirSync("dist/.well-known", { recursive: true });
          copyFileSync(".well-known/apple-app-site-association", "dist/.well-known/apple-app-site-association");
        }
      },
    },
  ],
});
