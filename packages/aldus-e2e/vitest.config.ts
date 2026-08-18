import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The composed stack performs many durable, fsync'd writes per scenario (ADR-0005), and a
    // journey here spans a dozen service calls rather than one. Raised rather than mocked: a
    // mocked store would leave exactly the durability and resumption behaviour this package
    // exists to prove untested.
    testTimeout: 30_000,
  },
});
