/**
 * Face behaviour, including the upstream bug the model is required to keep.
 *
 * ISSUE-20260823-004: `epd_bitmap_stand` and `epd_bitmap_defualt` are declared
 * `__attribute__((weak))` at `firmware/face-bitmaps.h:52` and never defined. F3
 * confirmed at binary level that `nm` finds no such symbols in the linked ELF.
 * `countFrames()` therefore returns 0 for both, `setFace()` falls through to a
 * fallback table that is also empty, and `updateFaceBitmap()` is never reached.
 *
 * The visible consequence is that `setFace("stand")` **emits nothing at all**
 * and leaves whatever was last drawn on the panel, while quietly renaming the
 * current face to `"default"`. Every pose in the firmware ends with
 * `runStandPose(1)`, so this fires constantly on a real robot.
 */
import { describe, expect, it } from 'vitest';

import { lookupFace } from '@sesame-lab/sesame-protocol';

import { makeRig } from './helpers.js';

describe('the empty-face bug (ISSUE-20260823-004)', () => {
  it.each(['stand', 'default', 'defualt'])(
    'setFace(%o) emits no face.expression at all',
    async (name) => {
      const rig = await makeRig();
      rig.clear();
      await rig.robot.setFace(name);
      expect(rig.ofType('face.expression')).toEqual([]);
      expect(rig.events).toEqual([]);
    },
  );

  it('renames the current face to "default" without drawing it', async () => {
    const rig = await makeRig();
    await rig.robot.setFace('wave');
    expect(rig.robot.snapshot().currentFaceName).toBe('wave');
    rig.clear();

    await rig.robot.setFace('stand');
    expect(rig.robot.snapshot().currentFaceName).toBe('default');
    expect(rig.robot.snapshot().currentFaceFrameCount).toBe(0);
    expect(rig.events).toEqual([]);
  });

  it('is exercised by ordinary choreography, not just by direct calls', async () => {
    const rig = await makeRig();
    rig.clear();
    // runStandPose(1) does setFaceWithMode("stand", ONCE) then enterIdle().
    await rig.robot.runMovement('runStandPose', { face: 1 });
    const faces = rig.ofType('face.expression').map((e) => e.name);
    expect(faces).not.toContain('stand');
    // What the panel actually ends up showing is the idle face, from enterIdle.
    expect(faces).toContain('idle');
  });

  it('an unknown face name takes the same silent fallback', async () => {
    const rig = await makeRig();
    rig.clear();
    await expect(rig.robot.setFace('banana')).resolves.toBeUndefined();
    expect(rig.events).toEqual([]);
    expect(rig.robot.snapshot().currentFaceName).toBe('default');
  });

  it('the catalog agrees the bitmaps are missing', () => {
    expect(lookupFace('stand')?.frameCount).toBe(0);
    expect(lookupFace('defualt')?.frameCount).toBe(0);
    expect(lookupFace('default')?.frameCount).toBe(0);
  });
});

describe('face playback mode is global state, not a face property', () => {
  it('setFace() alone does not change the mode', async () => {
    const rig = await makeRig();
    await rig.robot.setFaceWithMode('dance', 'loop');
    expect(rig.robot.snapshot().currentFaceMode).toBe('loop');
    await rig.robot.setFace('rest');
    // `rest` is played boomerang at its one choreography call site, but a bare
    // setFace() inherits whatever was global — here, loop.
    expect(rig.robot.snapshot().currentFaceMode).toBe('loop');
  });

  it('the same face plays under different modes at different call sites', async () => {
    // `dead` is selected ONCE in runShrugPose and BOOMERANG in runDeadPose.
    const shrug = await makeRig();
    await shrug.robot.runMovement('runShrugPose');

    const dead = await makeRig();
    dead.clear();
    await dead.robot.runMovement('runDeadPose');
    expect(dead.robot.snapshot().currentFaceMode).toBe('boomerang');
    expect(dead.robot.snapshot().currentFaceName).toBe('dead');

    // Two modes for one face, so the mode cannot be a property of the face.
    const modes = lookupFace('dead')?.modes ?? [];
    expect([...modes].sort()).toEqual(['boomerang', 'once']);
  });

  it('boomerang really does ping-pong; once really does stop', async () => {
    // `point`: 3 frames at 5 fps, so a 200 ms frame interval. Not `rest`, which
    // the boot sequence already selected — asking for it again would hit
    // setFace()'s early return and only change the mode.
    const boomerang = await makeRig();
    boomerang.clear();
    await boomerang.robot.setFaceWithMode('point', 'boomerang');
    await boomerang.robot.runFor(1200);
    // Frame 0 is drawn by setFace() itself. The first *advance* is immediate,
    // because setFace() resets lastFaceFrameMs to 0 and `millis() - 0 >=
    // interval` is true on any robot that has been up longer than one frame.
    const frames = boomerang.ofType('face.expression').map((e) => e.frame);
    expect(frames.slice(0, 6)).toEqual([0, 1, 2, 1, 0, 1]);

    const once = await makeRig();
    once.clear();
    await once.robot.setFaceWithMode('point', 'once');
    await once.robot.runFor(1200);
    // The trailing repeat of frame 2 is upstream's, not a modelling slip: on
    // the tick that discovers `index + 1 >= count`, updateAnimatedFace() pins
    // the index to the last frame, sets faceAnimFinished — and still falls
    // through to updateFaceBitmap(), redrawing the frame it is already on
    // (ino:966-970 then :980).
    expect(once.ofType('face.expression').map((e) => e.frame)).toEqual([0, 1, 2, 2]);
    expect(once.robot.snapshot().faceAnimFinished).toBe(true);
  });

  it('re-selecting the boot face only changes the mode, never redraws', async () => {
    const rig = await makeRig();
    rig.clear();
    await rig.robot.setFaceWithMode('rest', 'boomerang');
    // setFace()'s early return fires: same name, frames already attached.
    expect(rig.ofType('face.expression')).toEqual([]);
    expect(rig.robot.snapshot().currentFaceMode).toBe('boomerang');
  });
});

describe('setFace() lookup semantics', () => {
  it('matches the registry case-insensitively but reports the requested spelling', async () => {
    const rig = await makeRig();
    rig.clear();
    await rig.robot.setFace('WaVe');
    const [event] = rig.ofType('face.expression');
    expect(event?.name).toBe('WaVe');
    expect(rig.robot.snapshot().currentFaceFrameCount).toBe(1);
  });

  it('early-returns on an unchanged name, so nothing is re-emitted', async () => {
    const rig = await makeRig();
    await rig.robot.setFace('wave');
    rig.clear();
    await rig.robot.setFace('wave');
    expect(rig.events).toEqual([]);
  });

  it('the early return is case-sensitive even though the lookup is not', async () => {
    const rig = await makeRig();
    await rig.robot.setFace('wave');
    rig.clear();
    await rig.robot.setFace('Wave');
    // Same face, different spelling: the guard misses and the body re-runs.
    expect(rig.ofType('face.expression')).toHaveLength(1);
  });

  it('boots showing "rest", exactly as setup() does', async () => {
    const rig = await makeRig();
    const [hello, face] = rig.events;
    expect(hello?.type).toBe('protocol.hello');
    expect(face).toMatchObject({ type: 'face.expression', name: 'rest', frame: 0 });
    expect(rig.robot.snapshot().currentFaceMode).toBe('loop'); // the ino:58 initial value
  });
});

describe('idle', () => {
  it('is entered only by runStandPose(face == 1), never by inactivity', async () => {
    const rig = await makeRig();
    // The README claims inactivity-based entry. The source does not implement it.
    await rig.robot.runFor(60_000);
    expect(rig.robot.snapshot().idleActive).toBe(false);

    await rig.robot.runMovement('runStandPose', { face: 1 });
    expect(rig.robot.snapshot().idleActive).toBe(true);
  });

  it('blinks only while loop() is running, never during a movement', async () => {
    const rig = await makeRig();
    await rig.robot.runMovement('runStandPose', { face: 1 });
    rig.clear();

    // runBowPose holds for 3 s, but updateIdleBlink() is not called from
    // delayWithFace(), so no blink can happen inside it.
    await rig.robot.runMovement('runBowPose');
    expect(rig.ofType('face.expression').map((e) => e.name)).not.toContain('idle_blink');

    await rig.robot.runMovement('runStandPose', { face: 1 });
    rig.clear();
    await rig.robot.runFor(20_000);
    expect(rig.ofType('face.expression').map((e) => e.name)).toContain('idle_blink');
  });

  it('is left by exitIdle(), which every non-stop command triggers', async () => {
    const rig = await makeRig();
    await rig.robot.runMovement('runStandPose', { face: 1 });
    expect(rig.robot.snapshot().idleActive).toBe(true);
    await rig.robot.command('rest');
    expect(rig.robot.snapshot().idleActive).toBe(false);
  });

  it('is NOT left by stop, which only clears currentCommand', async () => {
    const rig = await makeRig();
    await rig.robot.runMovement('runStandPose', { face: 1 });
    await rig.robot.command('stop');
    expect(rig.robot.snapshot().idleActive).toBe(true);
  });
});
