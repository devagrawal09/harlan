import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const apiUrl = process.env.HARLAN_API_URL ?? "http://localhost:43117";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [solid()],
  define: {
    __HARLAN_API_URL__: JSON.stringify(apiUrl.replace(/\/$/, "")),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
