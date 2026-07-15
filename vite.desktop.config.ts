import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "desktop",
  publicDir: "../public",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../dist-desktop",
    emptyOutDir: true,
    sourcemap: false,
  },
});
