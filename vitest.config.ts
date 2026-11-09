import path from "node:path";
import { defineConfig } from "vitest/config";

const names = ["bibtex", "latex", "arxiv", "anon", "pdf-check", "image"];

export default defineConfig({
  resolve: {
    // Test workspace packages against each other's sources, not their built dist.
    alias: Object.fromEntries(names.map((n) => [`@paperkit/${n}`, path.resolve(__dirname, `packages/${n}/src/index.ts`)])),
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    environment: "node",
  },
});
