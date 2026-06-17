import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure logic only — no DOM/runtime browser APIs are exercised (MediaStream
    // values are treated as opaque references), so the fast node env is enough.
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/sfu-events.ts", "src/sfu-types.ts", "src/types.ts"],
    },
  },
});
