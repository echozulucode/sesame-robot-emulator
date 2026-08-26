import { createHash } from 'node:crypto';
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

/**
 * Publish the four annotated firmware files at `upstream/<path>`.
 *
 * ## The problem
 *
 * The source explorer renders real Sesame source at real line numbers, and that
 * source lives in `firmware/upstream/`, which is **gitignored** — fetched by
 * `scripts/fetch-upstream.*`, absent from a clean clone, and absent from any
 * deployed build unless something puts it there.
 *
 * Vendoring the four files into `src/` so they ride in git was rejected: this
 * repository deliberately does not commit upstream source, and a build step
 * that quietly reversed that decision would be the wrong kind of convenient.
 *
 * This is the same shape `serveGlb()` above already uses for
 * `assets/sesame.glb`: a dev middleware and a build-time `emitFile`, both
 * reading the one tree that already exists, with no second copy anywhere.
 *
 * ## What it refuses to do
 *
 * If a file is present but does **not** hash to what
 * `hardware/source-annotations.json` recorded, the build **fails**. Every line
 * number in that artefact — 90 symbol ranges, 261 citations — is an offset into
 * one specific tree, and emitting a different one produces a pane that looks
 * completely correct while boxing the wrong function.
 *
 * If a file is **absent**, the build warns and emits nothing. That is the clean
 * clone, and it is not an error: the app still builds, and the source pane says
 * "run scripts/fetch-upstream" rather than pretending.
 *
 * Either way the browser hashes the bytes it actually received before rendering
 * a single line (`src/source/load.ts`). This plugin protects the build; that
 * check protects the learner, and they are not the same threat.
 *
 * Exported so `src/__tests__/source.test.ts` can drive `generateBundle` against
 * a scratch tree and prove the refusal fires. A branch that has never run is a
 * branch that does not work.
 */
export function serveUpstreamSource(): Plugin {
  const annotations = JSON.parse(
    fs.readFileSync(path.join(REPO, 'hardware/source-annotations.json'), 'utf8'),
  ) as { meta: { filesAnnotated: { file: string; lines: number; sha256: string }[] } };
  const files = annotations.meta.filesAnnotated;
  /**
   * Where the pinned tree lives.
   *
   * Overridable so the build-time refusal can be *exercised* rather than merely
   * written: `scripts/capture-web-screenshots.mjs` points this at a scratch copy
   * with one byte changed and asserts the build fails. `firmware/upstream/` is
   * read-only to every agent in this project, so there is no other way to prove
   * the branch fires.
   */
  const UPSTREAM_DIR = process.env.SESAME_UPSTREAM_DIR ?? path.join(REPO, 'firmware/upstream');
  const diskPath = (file: string): string => path.join(UPSTREAM_DIR, file);
  const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

  return {
    name: 'sesame-serve-upstream-source',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split('?')[0] ?? '';
        if (!pathname.startsWith('/upstream/')) return next();
        const rel = decodeURIComponent(pathname.slice('/upstream/'.length));
        const known = files.find((f) => f.file === rel);
        if (known === undefined || !fs.existsSync(diskPath(rel))) {
          res.statusCode = 404;
          res.end('not an annotated file, or firmware/upstream/ has not been fetched\n');
          return;
        }
        // Deliberately NOT verified here. `vite dev` should stay usable while a
        // developer is mid-fetch, and the browser refuses to render a mismatch
        // anyway — which is the path worth exercising in development.
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        fs.createReadStream(diskPath(rel)).pipe(res);
      });
    },
    generateBundle() {
      const missing: string[] = [];
      for (const file of files) {
        const onDisk = diskPath(file.file);
        if (!fs.existsSync(onDisk)) {
          missing.push(file.file);
          continue;
        }
        const bytes = fs.readFileSync(onDisk);
        const actual = sha256(bytes);
        if (actual !== file.sha256) {
          this.error(
            `firmware/upstream/${file.file} does not match the tree ` +
              `hardware/source-annotations.json was written against.\n` +
              `  expected sha256 ${file.sha256}\n` +
              `  actual   sha256 ${actual}\n` +
              `Every symbol range and citation in that artefact is a line offset into the ` +
              `pinned tree. Re-run scripts/fetch-upstream, or regenerate the annotations.`,
          );
        }
        this.emitFile({
          type: 'asset',
          fileName: `upstream/${file.file}`,
          source: bytes,
        });
      }
      if (missing.length > 0) {
        this.warn(
          `firmware/upstream/ is missing ${String(missing.length)} of ${String(files.length)} ` +
            `annotated files (${missing.join(', ')}). The source explorer will say so rather ` +
            `than render anything. Run scripts/fetch-upstream to populate it.`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), serveGlb(), serveUpstreamSource()],
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
    chunkSizeWarningLimit: 1800,
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
