import { defineConfig } from "vitest/config";

const include = process.env.VITEST_LIVE_EVAL
  ? ["src/**/*.eval.ts"]
  : ["src/**/*.{test,spec}.ts", "web/**/*.{test,spec}.{ts,tsx}"];

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/dist/**", "**/.repos/**"],
    include,
  },
});
