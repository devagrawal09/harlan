import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/.repos/**"],
    include: ["src/**/*.{test,spec}.ts", "web/**/*.{test,spec}.{ts,tsx}"],
  },
});
