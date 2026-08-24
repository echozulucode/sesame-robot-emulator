/**
 * The 3D view: `assets/sesame.glb`, eight joints, one OLED quad, no physics.
 *
 * Gate E says no near-term lesson needs a physics engine, so there is none.
 * Every frame is forward kinematics: read a commanded angle out of the store,
 * turn it into a local quaternion with the rule the asset carries, done. The
 * GLB's parenting takes a foot with its femur; nothing composes transforms by
 * hand and nothing integrates anything over time.
 *
 * The scene does **not** subscribe to React state for joint angles. It polls
 * `store.poseVersion` inside `useFrame` and writes straight onto
 * `Object3D.quaternion`, which is what makes the browser test meaningful: the
 * numbers the harness reads back come out of the scene graph, not out of a
 * React render.
 */
import { Canvas, useFrame, useLoader, useThree, type ThreeEvent } from '@react-three/fiber';
import { JOINT_ORDER, type JointName } from '@sesame-lab/sesame-model';
import { useCallback, useEffect, useMemo, useRef, type ReactElement } from 'react';
import {
  CanvasTexture,
  Color,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  Object3D,
  PerspectiveCamera,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { TelemetryStore } from '../state/telemetry-store.js';
import {
  applyCommandedDeg,
  buildRig,
  computeGroundPlaneMm,
  groundReferenceMm,
  MM_PER_UNIT,
  readAssetFacts,
  type AssetFacts,
  type JointRig,
} from './rig.js';

/**
 * Where the GLB lives.
 *
 * Resolved against `document.baseURI` rather than hardcoded to `/sesame.glb`,
 * because the built app is served from three different places: the Vite dev
 * server, `vite preview`, and the Phase-0 bridge's own static server when the
 * WebSocket backend is being demonstrated on one origin.
 */
export const GLB_URL =
  typeof document === 'undefined' ? '/sesame.glb' : new URL('sesame.glb', document.baseURI).href;

export interface SceneHandles {
  readonly rig: Record<JointName, JointRig>;
  readonly facts: AssetFacts;
  readonly root: Object3D;
  /** Recomputed from the posed foot vertices whenever the pose changes. */
  groundPlaneMm(): number | null;
  /**
   * Frames the render loop has drawn, and the pose version it last applied.
   *
   * Diagnostics, and not idle ones: a stalled `useFrame` leaves every
   * scene-graph reading stale but perfectly plausible, which is the single
   * nastiest failure mode this app has. The browser harness asserts these move.
   */
  renderStats(): { frames: number; appliedPoseVersion: number };
  /**
   * Where the world's fixed things actually are, off `matrixWorld`.
   *
   * Every number in here is supposed to be a constant, and the reason this
   * accessor exists is that one of them was not: the grid used to be driven
   * from the pose-dependent ground plane and slid vertically under a robot
   * whose root never moves (ISSUE-20260823-023). Joint readings alone cannot
   * see that class of bug — the joints were perfectly correct the whole time —
   * so the harness needs to be able to read the *frame* as well as the pose.
   */
  worldFrame(): WorldFrameReading;
}

/**
 * The scene's world-space reference frame, in canonical millimetres.
 *
 * World space here **is** V2's canonical frame: the GLB root sits at the world
 * origin and is never translated, which is what lets `pivotWorldMm` and
 * `computeGroundPlaneMm` report canonical coordinates straight off
 * `matrixWorld`. Everything below except `footContactMm` must therefore hold
 * still for the entire life of the page unless the user drags the mouse.
 */
export interface WorldFrameReading {
  /** The floor/grid group's world origin. Pinned; never posed. */
  readonly groundWorldMm: readonly [number, number, number] | null;
  /** The GLB root's world origin. The canonical origin, i.e. (0, 0, 0). */
  readonly robotRootWorldMm: readonly [number, number, number] | null;
  /** `OrbitControls.target`. Only a mouse drag may move it. */
  readonly cameraTargetMm: readonly [number, number, number] | null;
  readonly cameraPositionMm: readonly [number, number, number] | null;
  /** Where the floor is pinned, as read out of the asset. */
  readonly groundReferenceMm: number | null;
  /**
   * The pose-dependent foot contact height — reported, and deliberately
   * applied to no transform at all. This is the value the grid used to chase.
   */
  readonly footContactMm: number | null;
}

/**
 * The mutable handoff between the three pieces of the scene.
 *
 * `SesameRig`, `GroundPlane` and `CameraControls` are siblings under one
 * `<Canvas>`; the debug surface needs to read all three. A plain object beats
 * a React context here because nothing reading it should cause a re-render.
 */
interface SceneRefs {
  ground: Object3D | null;
  camera: PerspectiveCamera | null;
  controls: OrbitControls | null;
  groundReferenceMm: number | null;
}

export type DriveSource = 'commanded' | 'simulated';

export interface RobotSceneProps {
  readonly store: TelemetryStore;
  readonly selected: JointName | null;
  readonly onSelect: (joint: JointName | null) => void;
  /** The canvas the virtual OLED draws into. Projected onto `oled_screen`. */
  readonly oledCanvas: HTMLCanvasElement;
  /**
   * Incremented by the OLED panel every time it repaints that canvas.
   *
   * A ref rather than a prop value on purpose: uploading the texture is a
   * three.js concern, and routing it through React state would re-render the
   * whole app once per animation frame of a face.
   */
  readonly oledDirty: React.RefObject<number>;
  readonly driveFrom: DriveSource;
  readonly onReady: (handles: SceneHandles) => void;
  readonly showTopCover: boolean;
}

export function RobotScene(props: RobotSceneProps): ReactElement {
  const refs = useMemo<SceneRefs>(
    () => ({ ground: null, camera: null, controls: null, groundReferenceMm: null }),
    [],
  );
  return (
    <Canvas
      // Three-quarter view from IN FRONT of the robot. Forward is -Z, so a
      // camera at -Z is where an observer facing the robot stands — which is
      // the only place the OLED is visible at all: the screen quad is
      // single-sided and its outward normal is (0, +0.342, -0.940).
      camera={{ position: [0.155, 0.085, -0.255], fov: 35, near: 0.005, far: 20 }}
      // Deterministic pixels for the headless capture: no device-pixel-ratio
      // guessing, and preserveDrawingBuffer so a screenshot cannot catch a
      // cleared buffer.
      dpr={1}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      onPointerMissed={() => props.onSelect(null)}
      // The headless harness reads this canvas's drawing buffer back to prove
      // the browser rendered something; it finds it by this class.
      className="webgl-canvas"
    >
      <color attach="background" args={['#0d1015']} />
      <hemisphereLight args={['#cfd8e6', '#1b1f27', 1.15]} />
      <directionalLight position={[0.4, 0.6, 0.5]} intensity={2.1} />
      <directionalLight position={[-0.5, 0.3, -0.4]} intensity={0.8} color="#9db4d8" />
      <SesameRig {...props} refs={refs} />
      <CameraControls refs={refs} />
    </Canvas>
  );
}

function CameraControls({ refs }: { readonly refs: SceneRefs }): null {
  const camera = useThree((s) => s.camera);
  const domElement = useThree((s) => s.gl.domElement);
  const controls = useRef<OrbitControls | null>(null);

  useEffect(() => {
    const c = new OrbitControls(camera as PerspectiveCamera, domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    // Set once, at construction, and never written again. Nothing in this app
    // re-aims the camera at the robot: if the view appears to drift, the cause
    // is in the scene, not here — which is exactly how ISSUE-20260823-023 was
    // traced to the grid. The harness reads this target back to keep it true.
    c.target.set(0, -0.012, -0.008);
    c.minDistance = 0.08;
    c.maxDistance = 1.5;
    c.update();
    controls.current = c;
    refs.camera = camera as PerspectiveCamera;
    refs.controls = c;
    return () => {
      c.dispose();
      controls.current = null;
      refs.camera = null;
      refs.controls = null;
    };
  }, [camera, domElement, refs]);

  useFrame(() => controls.current?.update());
  return null;
}

const SELECTED_EMISSIVE = new Color('#3d6fd8');
const BLACK = new Color('#000000');

function SesameRig(props: RobotSceneProps & { readonly refs: SceneRefs }): ReactElement {
  const { store, selected, onSelect, oledCanvas, oledDirty, driveFrom, onReady, showTopCover, refs } = props;
  const gltf = useLoader(GLTFLoader, GLB_URL);

  const built = useMemo(() => {
    const root = gltf.scene;
    const rig = buildRig(root);
    const oledNode = root.getObjectByName('oled_screen');
    const topCover = root.getObjectByName('body_top_cover');
    const facts = readAssetFacts(gltf.asset.extras, oledNode, topCover);

    // Every joint gets its own material instance so selecting one can tint it.
    // V2 ships four shared materials (shell / femur / foot / oled); tinting a
    // shared one would light up all four legs.
    for (const joint of JOINT_ORDER) {
      rig[joint].node.traverse((child) => {
        if (!(child instanceof Mesh)) return;
        if (Array.isArray(child.material)) return;
        child.material = child.material.clone();
      });
    }
    return { root, rig, facts, oledNode, topCover };
  }, [gltf]);

  const groundMm = useRef<number | null>(null);
  const appliedPose = useRef(-1);
  const appliedSource = useRef<DriveSource | null>(null);
  const frames = useRef(0);

  // --------------------------------------------------------------- OLED map
  const oledTexture = useMemo(() => {
    const texture = new CanvasTexture(oledCanvas);
    // V2 §6: the quad's TEXCOORD_0 follows glTF's image convention with the
    // origin top-left, and three.js flips non-glTF textures by default. Without
    // this the face is upside down and the "pixel (0,0) is top-left as seen by
    // someone facing the robot" contract quietly breaks.
    texture.flipY = false;
    // 128x64 stretched over 23.6 x 11.8 mm. Nearest on both filters, because
    // the whole point of the panel is that individual pixels are visible.
    texture.magFilter = NearestFilter;
    texture.minFilter = NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }, [oledCanvas]);

  useEffect(() => {
    const node = built.oledNode;
    if (!(node instanceof Mesh)) return;
    // Unlit: an OLED emits its own light, so shading it with the scene's lamps
    // would be wrong in a way a learner would notice.
    const material = new MeshBasicMaterial({ map: oledTexture, toneMapped: false });
    const previous = node.material;
    node.material = material;
    return () => {
      node.material = previous;
      material.dispose();
    };
  }, [built.oledNode, oledTexture]);

  const uploadedOled = useRef(-1);
  useFrame(() => {
    if (oledDirty.current === uploadedOled.current) return;
    uploadedOled.current = oledDirty.current;
    oledTexture.needsUpdate = true;
  });

  useEffect(() => () => oledTexture.dispose(), [oledTexture]);

  // ------------------------------------------------------------- visibility
  useEffect(() => {
    if (built.topCover !== undefined) built.topCover.visible = showTopCover;
  }, [built.topCover, showTopCover]);

  // ------------------------------------------------------------- selection
  useEffect(() => {
    for (const joint of JOINT_ORDER) {
      const on = joint === selected;
      built.rig[joint].node.traverse((child) => {
        if (!(child instanceof Mesh)) return;
        const material = child.material;
        if (Array.isArray(material) || !(material instanceof MeshStandardMaterial)) return;
        material.emissive.copy(on ? SELECTED_EMISSIVE : BLACK);
        material.emissiveIntensity = on ? 0.55 : 0;
      });
    }
  }, [built.rig, selected]);

  // ------------------------------------------------------------------ ready
  const floorMm = groundReferenceMm(built.facts);
  refs.groundReferenceMm = floorMm;

  useEffect(() => {
    onReady({
      rig: built.rig,
      facts: built.facts,
      root: built.root,
      groundPlaneMm: () => groundMm.current,
      renderStats: () => ({ frames: frames.current, appliedPoseVersion: appliedPose.current }),
      worldFrame: () => readWorldFrame(refs, built.root, groundMm.current),
    });
  }, [built, onReady, refs]);

  // ----------------------------------------------------------------- drive
  useFrame(() => {
    frames.current += 1;
    if (store.poseVersion === appliedPose.current && appliedSource.current === driveFrom) return;
    appliedPose.current = store.poseVersion;
    appliedSource.current = driveFrom;

    for (const joint of JOINT_ORDER) {
      const view = store.joints[joint];
      // Never commanded => leave the node at the asset's rest transform, which
      // IS the neutral pose. Snapping it to 90 would claim the robot is at 90;
      // the firmware's setup() attaches the servos and deliberately does not
      // move them, so nobody knows where the horns are.
      const deg = driveFrom === 'simulated' ? (view.simulatedDeg ?? view.commandedDeg) : view.commandedDeg;
      if (deg === null) continue;
      applyCommandedDeg(built.rig[joint], deg);
    }
    groundMm.current = computeGroundPlaneMm(built.rig);
  });

  // Simulated-angle playback changes continuously, so the pose-version gate
  // above would stall it. Re-arm every frame while that source is selected.
  useFrame(() => {
    if (driveFrom !== 'simulated') return;
    appliedPose.current = -1;
  });

  const handleClick = (event: ThreeEvent<MouseEvent>): void => {
    event.stopPropagation();
    let node: Object3D | null = event.object;
    while (node !== null) {
      const name = node.name as JointName;
      if ((JOINT_ORDER as readonly string[]).includes(name)) {
        onSelect(name);
        return;
      }
      node = node.parent;
    }
    onSelect(null);
  };

  return (
    <group>
      <primitive object={built.root} onClick={handleClick} />
      <GroundPlane mm={floorMm} refs={refs} />
    </group>
  );
}

/**
 * The floor. One fixed plane, and the scene's only spatial reference.
 *
 * It used to chase `computeGroundPlaneMm(rig)` every frame, on the reasoning
 * that V2 forbids baking the ground plane in as a constant. V2 forbids baking
 * it into the **asset**, and it is right to: it is a property of a pose. But a
 * *viewer* is a different consumer. The robot root is pinned at the canonical
 * origin and never moves, so a grid that tracks the pose slides vertically
 * under a stationary robot — 37.5 mm of it between the rest pose (−31.115 mm)
 * and `runStandPose` (−68.650 mm), which happens the instant any movement is
 * commanded. With nothing else static on screen, that reads as the whole world
 * jumping. ISSUE-20260823-023.
 *
 * So: the floor is fixed and the robot's feet move relative to it, which is
 * both what a robot on a desk does and what makes the grid usable as a ruler.
 * The height comes from `groundReferenceMm`, which reads the reference pose's
 * plane out of the asset — still not a number anyone typed, and see that
 * function for why the robot is not translated to settle onto it.
 *
 * The live pose-dependent value is still computed and still displayed, in the
 * asset panel, where a changing number is information rather than a wobble.
 */
function GroundPlane({
  mm,
  refs,
}: {
  readonly mm: number;
  readonly refs: SceneRefs;
}): ReactElement {
  // Stable identity: an inline callback ref is re-invoked with null on every
  // re-render, and `worldFrame()` is polled from outside React.
  const attach = useCallback(
    (node: Object3D | null): void => {
      refs.ground = node;
    },
    [refs],
  );

  return (
    <group ref={attach} name="ground_reference" position={[0, mm / MM_PER_UNIT, 0]}>
      <gridHelper args={[0.5, 20, '#2c3444', '#1a2029']} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.0002, 0]}>
        <planeGeometry args={[0.5, 0.5]} />
        <meshStandardMaterial color="#12161d" roughness={1} metalness={0} />
      </mesh>
    </group>
  );
}

/** Scratch vector — `worldFrame()` is polled, and must not allocate per call. */
const WORLD = new Vector3();

function toMm(node: Object3D | null): [number, number, number] | null {
  if (node === null) return null;
  node.updateWorldMatrix(true, false);
  node.getWorldPosition(WORLD);
  return [WORLD.x * MM_PER_UNIT, WORLD.y * MM_PER_UNIT, WORLD.z * MM_PER_UNIT];
}

/**
 * Read the world frame back out of three.js.
 *
 * Deliberately not "return the constants we set": every number here is fetched
 * from the live object — `matrixWorld` for the two groups, `OrbitControls`'
 * own target vector for the camera — because the whole point is to catch code
 * that moved something it should not have.
 */
function readWorldFrame(
  refs: SceneRefs,
  root: Object3D,
  footContactMm: number | null,
): WorldFrameReading {
  const target = refs.controls?.target ?? null;
  const camera = refs.camera ?? null;
  return {
    groundWorldMm: toMm(refs.ground),
    robotRootWorldMm: toMm(root),
    cameraTargetMm:
      target === null
        ? null
        : [target.x * MM_PER_UNIT, target.y * MM_PER_UNIT, target.z * MM_PER_UNIT],
    cameraPositionMm:
      camera === null
        ? null
        : [
            camera.position.x * MM_PER_UNIT,
            camera.position.y * MM_PER_UNIT,
            camera.position.z * MM_PER_UNIT,
          ],
    groundReferenceMm: refs.groundReferenceMm,
    footContactMm,
  };
}
