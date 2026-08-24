import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Node, not jsdom: everything under test here is pure — the framebuffer
    // encoder, the store reduction, and the rig rules read off the real GLB.
    // The parts that genuinely need a browser are verified in a real browser
    // by scripts/capture-web-screenshots.mjs, not in a DOM emulator.
    environment: 'node',
  },
});
