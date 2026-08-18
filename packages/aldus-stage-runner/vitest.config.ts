import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // These tests drive a real filesystem, and every state transition costs a lock acquisition
    // plus several fsyncs (ADR-0005). Contract §6.4 requires an event per mutation, so one attempt
    // is three durable writes — cheap alone, but slow enough under parallel workers to exceed the
    // 5s default. Raised rather than worked around: mocking the store would leave the crash and
    // contention behaviour this package must get right completely untested.
    testTimeout: 30_000,
  },
});
