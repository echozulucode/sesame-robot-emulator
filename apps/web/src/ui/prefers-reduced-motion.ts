/**
 * `prefers-reduced-motion: reduce`, read once and shared — Phase 4 W6.
 *
 * The brief's invariant is that under this preference *"nonessential camera
 * tweens, sliding accordions, decorative graph movement and animated
 * transitions are disabled"*. Three quarters of that sentence is CSS and lives
 * in the stylesheet's `overrides` layer. The remaining quarter is the part
 * this module exists for, because it is the part CSS cannot reach:
 *
 * | motion | who owns it | how it is disabled |
 * |---|---|---|
 * | React Flow's `fitView` / `setCenter` tween | `@xyflow/react`, a JS animation on a `transform` | `duration: 0` |
 * | OrbitControls' inertial glide | three.js, integrated in `useFrame` | `enableDamping = false` |
 * | CSS transitions and keyframes | the stylesheet | `@media (prefers-reduced-motion: reduce)` |
 *
 * A CSS `transition: none` cannot stop either of the first two: React Flow
 * interpolates the transform in JavaScript and writes the finished value each
 * frame, and OrbitControls does not use CSS at all.
 *
 * ## It is a live preference, not a boot-time one
 *
 * The `MediaQueryList` is LIVE, and both call sites read it at the moment
 * they need it rather than at mount: a reader can turn the preference on while
 * the page is open, and the next graph reframe and the next rendered frame must
 * already know. That is why there is no React state here and no hook — the two
 * consumers are a `useEffect` that fires on selection and a `useFrame`
 * callback, neither of which is a render.
 *
 * ## Deliberately not a "reduce all motion" switch
 *
 * The robot's own articulation is NOT disabled. A joint rotating from 90° to
 * 135° is the observable the whole product is built to show — it is the
 * content, not a transition into it — and the brief's own motion table says as
 * much: *"Robot physical motion: whatever accurately communicates the
 * simulated motion."* What this turns off is the motion that decorates a state
 * change somebody has already made.
 */
const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * One `MediaQueryList`, memoised.
 *
 * {@link prefersReducedMotion} is read inside the three.js render loop — once
 * per frame, at 60 Hz — and `matchMedia()` allocates a new object on every
 * call. The list is live, so caching it costs nothing in correctness: its
 * `matches` reflects the preference at the moment it is read.
 */
let cached: MediaQueryList | null | undefined;

const list = (): MediaQueryList | null => {
  if (cached === undefined) {
    cached = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(QUERY) : null;
  }
  return cached;
};

/** The preference, right now. Safe before mount and in a non-DOM environment. */
export function prefersReducedMotion(): boolean {
  return list()?.matches ?? false;
}

/**
 * Milliseconds to hand an animated viewport call.
 *
 * A single function rather than a boolean at each call site, so that "reduced
 * motion means 0 ms" is stated once and a new call site cannot forget it.
 */
export function motionDurationMs(ms: number): number {
  return prefersReducedMotion() ? 0 : ms;
}
