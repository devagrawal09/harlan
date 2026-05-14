import https from "node:https";
import { lookup } from "node:dns";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const defaultApiUrl = "http://localhost:3000";
const portlessApiUrl = process.env.PORTLESS_URL
  ? new URL(process.env.PORTLESS_URL)
  : null;

if (portlessApiUrl) {
  portlessApiUrl.hostname = "api.harlan.localhost";
}

const apiUrl = process.env.HARLAN_API_URL ?? portlessApiUrl?.toString() ?? defaultApiUrl;

const portlessAgent = new https.Agent({
  lookup(hostname, options, callback) {
    if (hostname === "api.harlan.localhost") {
      callback(null, "127.0.0.1", 4);
      return;
    }

    return lookup(hostname, options, callback);
  },
});

export default defineConfig({
  root: import.meta.dirname,
  plugins: [solid()],
  server: {
    proxy: {
      "/api": {
        target: apiUrl,
        agent: apiUrl.startsWith("https://api.harlan.localhost") ? portlessAgent : undefined,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
