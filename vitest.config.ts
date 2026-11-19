import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // src/web/app.ts runs in the browser: the HTTP suites check it is served, not its DOM code
    coverage: { provider: "v8", include: ["src/**/*.ts"], exclude: ["src/index.ts", "src/web/**"] },
  },
});
