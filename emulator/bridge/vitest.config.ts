import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The end-to-end tests start real TCP and WebSocket servers and play a
    // 3.7 s choreography (compressed, but still real sockets). The default 5 s
    // is too tight to be trustworthy on a loaded machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Sockets bind real ports. Running suites in parallel inside one file is
    // fine (every port is ephemeral), but keep files serialised so a slow CI
    // box cannot pile up dozens of listeners at once.
    fileParallelism: false,
  },
});
