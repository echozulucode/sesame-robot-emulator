/**
 * What this runner actually built — stated once, beside the code that builds it.
 *
 * `hardware/lessons.json` declares **22 control kinds** and **34 check types**.
 * Stubbing 22 controls badly would be worse than building 16 well, so the scope
 * taken here is: **lessons 1–6, the six polished ones, fully playable end to
 * end**, which needs 16 controls and 26 checks. The remaining 6 controls and 8
 * checks are used *only* by outline lessons 7–19, and they are not built.
 *
 * The rule this file exists to enforce is that an unbuilt thing must **fail
 * loudly and visibly**. A control that renders nothing, or a check that quietly
 * passes, teaches a learner that the checks are decorative — which is the one
 * failure this whole feature cannot survive. So:
 *
 *  - a step whose control is not in {@link IMPLEMENTED_CONTROLS} renders
 *    `<NotBuilt>`: a red panel naming the control kind and saying it is not
 *    built;
 *  - a check whose type is not in {@link IMPLEMENTED_CHECKS} evaluates to
 *    `unsupported` in `checks.ts`, which is rendered as a refusal and can never
 *    become `passed`, be persisted, or unlock anything.
 *
 * The two lists below are asserted against `hardware/lessons.json` in
 * `__tests__/lessons.test.ts`: every id must be a declared one, and every control
 * or check a POLISHED lesson uses must be implemented. That test is what stops
 * this file drifting into a claim.
 */
import type { CheckTypeId, ControlKind } from '../generated/lessons.js';

/**
 * The 16 control kinds this runner binds.
 *
 * `sequence-editor`, `pixel-editor`, `subtrim-control`, `fault-injector` and
 * `http-console` live in `src/editors/` because L5 §8 authors them as **Lab**
 * tools that Learn borrows, not the other way round.
 */
export const IMPLEMENTED_CONTROLS: readonly ControlKind[] = [
  'robot-explode',
  'board-selector',
  'graph-node-picker',
  'pose-runner',
  'command-button',
  'joint-slider',
  'channel-number',
  'subtrim-control',
  'pwm-inspector',
  'trace-inspector',
  'source-selector',
  'sequence-editor',
  'face-picker',
  'pixel-editor',
  'fault-injector',
  'http-console',
];

/**
 * The 6 declared control kinds this runner does NOT build.
 *
 * Every one of them is used only by an outline lesson. `none` is declared by
 * L5 and used by no step at all.
 */
export const UNIMPLEMENTED_CONTROLS: readonly ControlKind[] = [
  'joint-picker',
  'serial-console',
  'boot-stepper',
  'backend-switch',
  'emulator-controls',
  'none',
];

/** The 26 success checks this runner evaluates against real state. */
export const IMPLEMENTED_CHECKS: readonly CheckTypeId[] = [
  'joints-identified',
  'board-switched',
  'source-span-selected',
  'pose-vector',
  'servo-target',
  'telemetry-absent',
  'commanded-angle-collision',
  'quantisation-collision',
  'pwm-value-matched',
  'quantisation-survey',
  'trace-badge-identified',
  'trace-field-absent',
  'trace-complete',
  'movement-joints-identified',
  'sequence-variation',
  'sequence-authored',
  'face-selected',
  'face-fallback',
  'face-reselect',
  'face-after-movement',
  'face-mode-identified',
  'pixel-edit',
  'http-request',
  'http-json-field',
  'subtrim-set',
  'boot-halt',
];

export const isControlImplemented = (kind: ControlKind): boolean =>
  IMPLEMENTED_CONTROLS.includes(kind);

export const isCheckImplemented = (type: CheckTypeId): boolean => IMPLEMENTED_CHECKS.includes(type);

/**
 * Why a given control is not built. Shown verbatim in the refusal panel, so a
 * learner reading an outline lesson knows this is a gap and not a bug.
 */
export const CONTROL_NOT_BUILT_REASON: Readonly<Record<string, string>> = {
  'joint-picker':
    'Clicking a joint in the 3D scene and in the joint list already works everywhere else in this ' +
    'app; it is not bound as a lesson control because the only steps that ask for it are outlines.',
  'serial-console':
    'No lesson in the playable set uses the firmware serial CLI. Building a console that cannot ' +
    'actually reach a guest UART would be a prop.',
  'boot-stepper':
    'The lab has a boot model (see the fault injector), but stepping it one bootOrder entry at a ' +
    'time is only asked for by sesame-on-a-network, which is an outline.',
  'backend-switch':
    'The backend switch exists in the sidebar and works. It is not bound as a lesson control ' +
    'because backend-switched — the check that would give it meaning — is not built.',
  'emulator-controls':
    'Starting, stopping and inspecting the QEMU-backed robot is the emulator panel’s job. The ' +
    'lessons that drive it (what-an-emulator-is, inside-qemu) are outlines.',
  none: 'Declared by lessons.json and used by no step.',
};
