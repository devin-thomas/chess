import { resolve } from "node:path";
import { defineConfig } from "vite";

const webRoot = resolve(process.cwd(), "web");

export default defineConfig({
  root: "web",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        viewer: resolve(webRoot, "index.html"),
        simulator: resolve(webRoot, "simulator/index.html"),
      },
    },
  },
});
