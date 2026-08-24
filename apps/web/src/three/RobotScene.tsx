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
import { useEffect, useMemo, useRef, type ReactElement } from 'react';
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
      <SesameRig {...props} />
      <CameraControls />
    </Canvas>
  );
}

function CameraControls(): null {
  const camera = useThree((s) => s.camera);
  const domElement = useThree((s) => s.gl.domElement);
  const controls = useRef<OrbitControls | null>(null);

  useEffect(() => {
    const c = new OrbitControls(camera as PerspectiveCamera, domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.target.set(0, -0.012, -0.008);
    c.minDistance = 0.08;
    c.maxDistance = 1.5;
    c.update();
    controls.current = c;
    return () => {
      c.dispose();
      controls.current = null;
    };
  }, [camera, domElement]);

  useFrame(() => controls.current?.update());
  return null;
}

const SELECTED_EMISSIVE = new Color('#3d6fd8');
const BLACK = new Color('#000000');

function SesameRig(props: RobotSceneProps): ReactElement {
  const { store, selected, onSelect, oledCanvas, oledDirty, driveFrom, onReady, showTopCover } = props;
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
  useEffect(() => {
    onReady({
      rig: built.rig,
      facts: built.facts,
      root: built.root,
      groundPlaneMm: () => groundMm.current,
      renderStats: () => ({ frames: frames.current, appliedPoseVersion: appliedPose.current }),
    });
  }, [built, onReady]);

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
      <GroundPlane groundMm={groundMm} />
    </group>
  );
}

/**
 * A grid at the pose-dependent ground plane.
 *
 * V2 is blunt about this: −68.650 mm at `runStandPose`, −31.115 mm at rest, and
 * "POSE-DEPENDENT: this is not a property of the frame and must not be baked in
 * as a constant". So the grid follows the recomputed value instead of sitting
 * at a number someone typed once.
 */
function GroundPlane({ groundMm }: { readonly groundMm: React.RefObject<number | null> }): ReactElement {
  const group = useRef<Object3D>(null);
  const shown = useRef<number | null>(null);

  useFrame(() => {
    const mm = groundMm.current;
    if (mm === null || group.current === null || mm === shown.current) return;
    shown.current = mm;
    group.current.position.y = mm / MM_PER_UNIT;
  });

  return (
    <group ref={group} position={new Vector3(0, -0.0686, 0)}>
      <gridHelper args={[0.5, 20, '#2c3444', '#1a2029']} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.0002, 0]}>
        <planeGeometry args={[0.5, 0.5]} />
        <meshStandardMaterial color="#12161d" roughness={1} metalness={0} />
      </mesh>
    </group>
  );
}
