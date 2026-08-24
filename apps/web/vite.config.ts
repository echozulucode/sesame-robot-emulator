import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

/** The V2 artefact. Committed at the repo root; NOT duplicated into this app. */
const GLB_SOURCE = path.join(REPO, 'assets/sesame.glb');

/** Where the app asks for it. Kept in one place: `src/assets.ts` imports this. */
export const GLB_PUBLIC_PATH = '/sesame.glb';

/**
 * Serve `assets/sesame.glb` without copying it into this package.
 *
 * The obvious move is `public/sesame.glb`, but that means a second 1.28 MB copy
 * of a deterministic, hash-recorded artefact living in git, and two files that
 * can drift. Instead: a dev-server middleware and a build-time `emitFile`, both
 * reading the one file `scripts/build-gltf.py` writes.
 */
function serveGlb(): Plugin {
  return {
    name: 'sesame-serve-glb',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== GLB_PUBLIC_PATH) return next();
        res.setHeader('content-type', 'model/gltf-binary');
        res.setHeader('cache-control', 'no-store');
        fs.createReadStream(GLB_SOURCE).pipe(res);
      });
    },
    generateBundle() {
      if (!fs.existsSync(GLB_SOURCE)) {
        this.error(
          `assets/sesame.glb is missing. Build it with:\n` +
            `  tools/py-assets/.venv/Scripts/python.exe scripts/build-gltf.py`,
        );
      }
      this.emitFile({
        type: 'asset',
        // Deliberately unhashed: the harness, the bridge's static server and
        // the docs all refer to it by this name.
        fileName: GLB_PUBLIC_PATH.slice(1),
        source: fs.readFileSync(GLB_SOURCE),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveGlb()],
  // Relative asset URLs so the build can be served from any origin — including
  // the Phase-0 bridge's own static server (`--viewer-dir apps/web/dist`),
  // which is how the WebSocket backend gets demonstrated on one origin.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // three + R3F is a big single chunk. Raising the warning threshold rather
    // than code-splitting: the app is one screen and lazy-loading the renderer
    // would only move the wait.
    chunkSizeWarningLimit: 1600,
  },
  server: {
    host: '127.0.0.1',
    fs: {
      // The GLB is read through the middleware above, but allow the repo root
      // so source maps into the workspace packages resolve in dev.
      allow: [REPO],
    },
    /**
     * `vite dev` in front of the lab host.
     *
     * The QEMU backend talks to `apps/web/server/lab-host.mjs`, which cannot
     * live in the browser bundle — it spawns `qemu-system-xtensa`. In a
     * production capture the lab host serves `dist/` itself and everything is
     * one origin; in dev, Vite serves the app and these five prefixes are
     * forwarded so the origin stays one anyway. That matters more than
     * convenience: an `EventSource` and a `POST` to a *different* origin drag
     * CORS into a lab tool, and the loopback-only posture would then have to be
     * relaxed to work around it.
     *
     * `/cmd`, `/getSettings` and `/setSettings` are firmware routes, not
     * inventions — `hardware-map.json → network.http.routes`. `/lab/*` is the
     * only pair that is ours.
     */
    proxy: Object.fromEntries(
      ['/api', '/lab', '/cmd', '/getSettings', '/setSettings'].map((prefix) => [
        prefix,
        {
          target: process.env.SESAME_LAB_HOST ?? 'http://127.0.0.1:8099',
          changeOrigin: false,
          // Server-sent events must not be buffered into oblivion.
          ws: false,
        },
      ]),
    ),
  },
});
