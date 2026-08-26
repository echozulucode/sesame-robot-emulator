#!/usr/bin/env node
/**
 * Project `hardware/hardware-map.json` into the architecture graph the Phase-2
 * app draws.
 *
 * ## The rule this script exists to enforce
 *
 * **A node that asserts something not in the data is a bug.** The report draws
 * a pretty tree; a pretty tree is easy to hand-draw and impossible to keep
 * true. So every node and every edge below is emitted from a field of
 * `hardware/hardware-map.json` (or `hardware/joint-map.json`), and carries:
 *
 * - `derivedFrom` — the path into the JSON it came from, so a reader can check
 *   it without trusting this file;
 * - `sourceRef` — the firmware `file:line` the JSON itself cites, which is what
 *   the source-explorer task will consume;
 * - `derivation` — `'derived'` or `'hand-authored'`. There are exactly
 *   {@link HAND_AUTHORED_BUDGET} hand-authored items and the generator fails if
 *   that number grows without the constant being changed deliberately.
 * - `unresolved` — the id of the `hardware-map.json → unresolved[]` entry when
 *   the node exists in the data but its *value* does not. `MG90S` is the
 *   headline case: the BOM names the part, and nothing in this repository
 *   records its torque, slew or travel.
 *
 * `hardware/` belongs to another agent this wave. This script only reads it.
 *
 * ## What is deliberately NOT drawn
 *
 * The report's example trace row is `pwm.output channel=6`. There is no
 * channel-to-servo mapping anywhere in this repository. Q3 measured *which
 * eight* LEDC channels are programmed (HSCH0-3, LSCH0-3) and explained the
 * allocation rule, but `hardware-map.json` records the eight as a **set**, and
 * no artefact says which one carries `L3`. So the LEDC node states the set and
 * says the per-joint assignment is unestablished. Drawing `channel=6` would be
 * inventing a fact in the one pane a learner is most likely to trust.
 *
 * Usage:
 *   node apps/web/scripts/build-architecture-graph.mjs           # regenerate
 *   node apps/web/scripts/build-architecture-graph.mjs --check    # fail on drift
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const HARDWARE_MAP = path.join(REPO, 'hardware/hardware-map.json');
const JOINT_MAP = path.join(REPO, 'hardware/joint-map.json');
const OUT = path.join(HERE, '../src/generated/architecture-graph.ts');

/**
 * How many nodes + edges may say `derivation: 'hand-authored'`.
 *
 * Not zero, and pretending otherwise would be its own dishonesty: the four
 * top-level *groupings* are an editorial choice about how to present a flat
 * JSON document, and "this GPIO pin drives that MG90S horn" is a wire nobody
 * in this repository has ever traced. Both are marked, both are listed in
 * `HAND_AUTHORED`, and the app renders them with a visible marker.
 */
const HAND_AUTHORED_BUDGET = 6;

const check = process.argv.includes('--check');

const map = JSON.parse(fs.readFileSync(HARDWARE_MAP, 'utf8'));
const jointMap = fs.existsSync(JOINT_MAP) ? JSON.parse(fs.readFileSync(JOINT_MAP, 'utf8')) : null;

// --------------------------------------------------------------------------
const nodes = [];
const edges = [];

/** `{file, line}` -> `"firmware/x.ino:1051"`, or null. */
const ref = (source) =>
  source === undefined || source === null || typeof source.file !== 'string'
    ? null
    : { file: source.file, line: typeof source.line === 'number' ? source.line : 0 };

function node(spec) {
  if (nodes.some((n) => n.id === spec.id)) fail(`duplicate node id ${spec.id}`);
  nodes.push({
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    group: spec.group,
    depth: spec.depth,
    parent: spec.parent ?? null,
    summary: spec.summary,
    detail: spec.detail ?? [],
    sourceRef: spec.sourceRef ?? null,
    derivation: spec.derivation ?? 'derived',
    derivedFrom: spec.derivedFrom,
    unresolved: spec.unresolved ?? null,
    joints: spec.joints ?? [],
    /** Trace layers whose rows belong to this node. Drives cross-highlighting. */
    traceLayers: spec.traceLayers ?? [],
  });
}

function edge(from, to, spec = {}) {
  edges.push({
    id: `${from}->${to}`,
    source: from,
    target: to,
    label: spec.label ?? null,
    derivation: spec.derivation ?? 'derived',
    derivedFrom: spec.derivedFrom ?? '',
    note: spec.note ?? null,
  });
}

const unresolvedById = Object.fromEntries((map.unresolved ?? []).map((u) => [u.id, u]));
const need = (id) => {
  if (unresolvedById[id] === undefined) fail(`hardware-map.json has no unresolved entry "${id}"`);
  return id;
};

// ============================================================== root: the MCU
const activeBoard = map.boards.find((b) => b.active === true);
if (activeBoard === undefined) fail('no board in hardware-map.json is marked active');

node({
  id: 'esp32',
  label: 'ESP32',
  kind: 'controller',
  group: 'root',
  depth: 0,
  summary: `${map.boards.length} board profiles; ${activeBoard.id} is the active one`,
  detail: map.boards.map(
    (b) =>
      `${b.id} — ${b.displayName} · ${b.mcuFamily}${b.active ? ' (ACTIVE)' : ''}` +
      (b.mcuFamilyVerified === false ? ' · mcuFamily not stated in firmware source' : ''),
  ),
  sourceRef: ref(activeBoard.servoPinsSource),
  derivedFrom: 'boards[]',
  traceLayers: [],
});

// ==================================================== the four setup() branches
//
// The grouping is editorial — hardware-map.json is flat — but the *members* are
// not: every branch below names the bootOrder subsystems it covers, and the
// generator asserts those subsystem strings exist in bootOrder[].
const bootSubsystems = new Set(map.bootOrder.map((b) => b.subsystem));
const coversBoot = (...subsystems) => {
  for (const s of subsystems) {
    if (!bootSubsystems.has(s)) fail(`bootOrder[] has no subsystem "${s}"`);
  }
  const steps = map.bootOrder.filter((b) => subsystems.includes(b.subsystem));
  return steps.map((b) => `setup() step ${b.order}: ${b.operation}`);
};

const servoSteps = map.movements.flatMap((m) => m.steps.filter((s) => s.type === 'servo'));
const totalSteps = map.movements.reduce((n, m) => n + m.steps.length, 0);

node({
  id: 'movement',
  label: 'Movement',
  kind: 'subsystem',
  group: 'movement',
  depth: 1,
  summary: `${map.movements.length} functions · ${totalSteps} steps · ${servoSteps.length} servo writes`,
  detail: [
    `Dispatched from ${map.commands.dispatchSymbol} via ${map.commands.stateVariable}.`,
    map.commands.dispatchNote,
    ...coversBoot('pwm', 'servo'),
  ],
  sourceRef: ref(map.movements[0].source),
  derivation: 'hand-authored',
  derivedFrom: 'movements[] + commands.dispatchSymbol + bootOrder[pwm,servo]',
  traceLayers: ['firmware.command', 'movement.enter'],
});

node({
  id: 'face',
  label: 'Face',
  kind: 'subsystem',
  group: 'face',
  depth: 1,
  summary: `${map.faces.count} faces registered · ${map.faces.maxFramesPerFace} frames max`,
  detail: [
    `Registry ${map.faces.registrySymbol}; lookup ${map.faces.lookupSymbol}(), case-insensitive.`,
    `Animation driver ${map.faces.animationDriver.symbol}, default ${map.faces.defaultFps} fps.`,
    map.faces.playbackModeOwnership,
  ],
  sourceRef: ref(map.faces.registrySource),
  derivation: 'hand-authored',
  derivedFrom: 'faces',
  traceLayers: [],
});

node({
  id: 'network',
  label: 'Network',
  kind: 'subsystem',
  group: 'network',
  depth: 1,
  summary: `SoftAP ${map.network.ap.ssid} · ${map.network.hostname}.local`,
  detail: [
    `${map.network.ap.startCall} — return value checked: ${String(map.network.ap.returnValueChecked)}.`,
    `Station mode compiled ${map.network.station.enabledAtCompileTime ? 'in' : 'OUT'} (${map.network.station.enableFlag}).`,
    map.network.ap.defaultIpNote,
    ...coversBoot('wifi', 'dns', 'mdns', 'http'),
  ],
  sourceRef: ref(map.network.ap.startSource),
  derivation: 'hand-authored',
  derivedFrom: 'network',
  traceLayers: ['http.request'],
});

node({
  id: 'serial',
  label: 'Serial',
  kind: 'subsystem',
  group: 'serial',
  depth: 1,
  summary: `${map.network.serial.baud} baud · ${map.network.serial.cliBufferBytes}-byte CLI buffer`,
  detail: coversBoot('serial'),
  sourceRef: ref(map.network.serial.baudSource),
  derivation: 'hand-authored',
  derivedFrom: 'network.serial + bootOrder[serial]',
  traceLayers: [],
});

edge('esp32', 'movement', { derivedFrom: 'bootOrder[pwm,servo]' });
edge('esp32', 'face', { derivedFrom: 'bootOrder[display]' });
edge('esp32', 'network', { derivedFrom: 'bootOrder[wifi,dns,mdns,http]' });
edge('esp32', 'serial', { derivedFrom: 'bootOrder[serial]' });

// ============================================================ the four targets
const JOINTS = map.servos.order;

node({
  id: 'servos',
  label: `${map.servos.count} Servos`,
  kind: 'peripheral',
  group: 'movement',
  depth: 2,
  summary: map.servos.order.join(' '),
  detail: [map.servos.orderNote, map.servos.servoConfig.convergencePoint.note],
  sourceRef: ref(map.servos.orderSource),
  derivedFrom: 'servos.order',
  joints: JOINTS,
  traceLayers: ['servo.target'],
});

node({
  id: 'oled',
  label: `OLED ${map.display.widthPx}×${map.display.heightPx}`,
  kind: 'peripheral',
  group: 'face',
  depth: 2,
  summary: `${map.display.driverLibrary} @ ${map.display.i2cAddress}`,
  detail: [
    map.display.instanceDeclaration,
    `Boot blocker: ${String(map.display.bootBlocker)} — ${map.display.bootFailureBehaviour}`,
  ],
  sourceRef: ref(map.display.instanceSource),
  derivedFrom: 'display',
  traceLayers: [],
});

node({
  id: 'http-api',
  label: 'HTTP API',
  kind: 'subsystem',
  group: 'network',
  depth: 2,
  summary: `${map.network.http.routes.length} routes on port ${map.network.http.port}`,
  detail: [
    `${map.network.http.library}, TLS ${JSON.stringify(map.network.http.tls)}, auth ${JSON.stringify(
      map.network.http.authentication,
    )}.`,
    map.network.http.routeRegistrationNote ?? '',
  ].filter((s) => s.length > 0),
  sourceRef: ref(map.network.http.beginSource),
  derivedFrom: 'network.http',
  traceLayers: ['http.request'],
});

node({
  id: 'developer',
  label: 'Developer',
  kind: 'actor',
  group: 'serial',
  depth: 2,
  summary: `${map.commands.serialCli.length} accepted CLI forms`,
  detail: [map.commands.serialCliDispatchNote],
  sourceRef: ref(map.network.serial.cliSource?.from),
  derivedFrom: 'commands.serialCli',
  traceLayers: [],
});

edge('movement', 'servos', {
  label: `${servoSteps.length} setServoAngle steps`,
  derivedFrom: 'movements[].steps[type=servo]',
});
edge('face', 'oled', { derivedFrom: 'display.renderPath' });
edge('network', 'http-api', { derivedFrom: 'network.http' });
edge('serial', 'developer', { derivedFrom: 'commands.serialCli' });

// ================================================== servos: the real chain
const cfg = map.servos.servoConfig;
const setter = cfg.setServoAngle;

node({
  id: 'servo.setServoAngle',
  label: 'setServoAngle()',
  kind: 'firmware',
  group: 'movement',
  depth: 3,
  parent: 'servos',
  summary: setter.signature,
  detail: setter.steps.map((s) => `${s.order}. ${s.description}`),
  sourceRef: ref(setter.source),
  derivedFrom: 'servos.servoConfig.setServoAngle',
  joints: JOINTS,
  traceLayers: ['servo.target'],
});

node({
  id: 'servo.esp32servo',
  label: 'ESP32Servo',
  kind: 'library',
  group: 'movement',
  depth: 4,
  parent: 'servos',
  summary: `Servo::write() → ${cfg.attachPulseClamp.effectiveMinUs}–${cfg.attachPulseClamp.effectiveMaxUs} µs`,
  detail: [
    `${cfg.attachCall} — but ${cfg.attachPulseClamp.note}`,
    `Library ${cfg.library} ${cfg.libraryVersionPinned} (${cfg.libraryVersionNote})`,
  ],
  sourceRef: ref(cfg.attachSource),
  derivedFrom: 'servos.servoConfig.attachPulseClamp',
  joints: JOINTS,
  traceLayers: ['pwm.output'],
});

const q = cfg.pulseQuantisation;
node({
  id: 'servo.ledc',
  label: 'LEDC / PWM',
  kind: 'peripheral',
  group: 'movement',
  depth: 5,
  parent: 'servos',
  summary: `${q.timerWidthBits}-bit · ${cfg.pwmFrequencyHz} Hz · ${q.distinctReachablePulseValues} of ${q.commandableAngles} angles distinguishable`,
  detail: [
    q.note,
    `Channels programmed (MEASURED): ${cfg.ledcChannelsProgrammed.join(', ')} across ${cfg.ledcSpeedGroupsUsed.join(' + ')}.`,
    cfg.pwmTimersProgrammedNote,
    'WHICH channel carries WHICH joint is not recorded anywhere in this repository. ' +
      'hardware-map.json lists the eight programmed channels as a set, not a per-joint mapping, ' +
      'so this app never prints a channel number beside a joint.',
  ],
  sourceRef: ref(cfg.pwmFrequencySource),
  derivedFrom: 'servos.servoConfig.pulseQuantisation + …ledcChannelsProgrammed',
  joints: JOINTS,
  traceLayers: ['pwm.output'],
});

node({
  id: 'servo.gpio',
  label: 'GPIO',
  kind: 'peripheral',
  group: 'movement',
  depth: 6,
  parent: 'servos',
  summary: `8 pins, per board — ${activeBoard.id}: ${JOINTS.map(
    (j) => map.servos.joints.find((x) => x.firmwareName === j).pinsByBoard[activeBoard.id],
  ).join(' ')}`,
  detail: map.boards.map(
    (b) =>
      `${b.id}: ${JOINTS.map(
        (j) => `${j}=${map.servos.joints.find((x) => x.firmwareName === j).pinsByBoard[b.id]}`,
      ).join(' ')}`,
  ),
  sourceRef: ref(activeBoard.servoPinsSource),
  derivedFrom: 'servos.joints[].pinsByBoard',
  joints: JOINTS,
  traceLayers: ['pwm.output'],
});

const servoModel = unresolvedById[need('servo-model')];
node({
  id: 'servo.mg90s',
  label: 'MG90S',
  kind: 'physical',
  group: 'movement',
  depth: 7,
  parent: 'servos',
  summary: 'named in the BOM; no torque, slew or travel data exists in this repo',
  detail: [servoModel.reason],
  sourceRef: ref(servoModel.source),
  derivedFrom: 'unresolved[servo-model]',
  unresolved: 'servo-model',
  joints: JOINTS,
  traceLayers: [],
});

edge('servos', 'servo.setServoAngle', {
  label: 'single convergence point',
  derivedFrom: 'servos.servoConfig.convergencePoint',
});
edge('servo.setServoAngle', 'servo.esp32servo', {
  label: setter.steps[2].description.split('.')[0],
  derivedFrom: 'servos.servoConfig.setServoAngle.steps[3]',
});
edge('servo.esp32servo', 'servo.ledc', {
  label: `usToTicks() → ticks ${q.minTick}–${q.maxTick}`,
  derivedFrom: 'servos.servoConfig.pulseQuantisation.tickConversionSource',
});
edge('servo.ledc', 'servo.gpio', {
  label: `${cfg.pwmFrequencyHz} Hz frame`,
  derivedFrom: 'servos.servoConfig.pwmFrequencyCall',
});
edge('servo.gpio', 'servo.mg90s', {
  label: 'one-way PWM, no feedback',
  derivedFrom: 'servos.servoConfig.setServoAngle.positionFeedbackNote',
});

// The one edge in this file that no artefact in this repository establishes.
edge('servo.mg90s', 'joint.R1', { derivation: 'hand-authored', derivedFrom: '(none)' });

// ------------------------------------------------------------- the 8 joints
const jointEntry = (name) => (jointMap?.joints ?? []).find((j) => j.firmwareName === name) ?? null;

for (const [i, name] of JOINTS.entries()) {
  const hw = map.servos.joints.find((x) => x.firmwareName === name);
  const jm = jointEntry(name);
  const detail = [
    `Servo channel ${hw.index} (enum index IS the identity; never re-sort).`,
    `Pins: ${map.boards.map((b) => `${b.id}=${hw.pinsByBoard[b.id]}`).join(' · ')}`,
  ];
  if (jm !== null) {
    detail.push(`Joint kind: ${jm.kind} (${jm.kindStatus}).`);
    detail.push(
      `Spatial name "${jm.semanticName.value}" — verified: ${String(jm.semanticName.verified)}. ` +
        'Permanently unverifiable: there is no physical robot to check it against.',
    );
  }
  node({
    id: `joint.${name}`,
    label: name,
    kind: 'joint',
    group: 'movement',
    depth: 8,
    parent: 'servos',
    summary: jm === null ? `channel ${hw.index}` : `channel ${hw.index} · ${jm.kind}`,
    detail,
    sourceRef: ref(hw.source),
    derivedFrom: `servos.joints[${hw.index}]`,
    joints: [name],
    traceLayers: ['servo.target', 'pwm.output', 'joint.target', 'visual.joint'],
  });
  if (i > 0) edge('servo.mg90s', `joint.${name}`, { derivation: 'hand-authored', derivedFrom: '(none)' });
}

// ==================================================== OLED: the real chain
const emptyFaces = (map.faces.faces ?? []).filter((f) => (f.frames ?? []).length === 0);
const rp = map.display.renderPath;

const oledChain = [
  {
    id: 'oled.faceName',
    label: 'face name',
    kind: 'firmware',
    summary: `${map.faces.lookupSymbol}(), case-insensitive, ${map.faces.count} registered`,
    detail: [
      `${map.faces.count} faces registered, ${map.faces.faceListEntryCount} in FACE_LIST.`,
      emptyFaces.length === 0
        ? 'Every registered face has at least one frame.'
        : `${emptyFaces.length} registered faces have ZERO frames and draw nothing: ` +
          `${emptyFaces.map((f) => f.name).join(', ')}.`,
    ],
    sourceRef: ref(map.faces.lookupSource),
    derivedFrom: 'faces.lookupSymbol + faces.faces[].frames',
  },
  {
    id: 'oled.bitmap',
    label: 'bitmap frame',
    kind: 'firmware',
    summary: `${map.faces.bitmapDimensions.widthPx}×${map.faces.bitmapDimensions.heightPx} · ${map.faces.bitmapDimensions.bytesPerFrame} B PROGMEM`,
    detail: [map.faces.bitmapDataNote],
    sourceRef: ref(map.faces.bitmapDimensionsSource),
    derivedFrom: 'faces.bitmapDimensions',
  },
  {
    id: 'oled.gfx',
    label: map.display.graphicsLibrary,
    kind: 'library',
    summary: rp.steps[1],
    detail: [`${rp.symbol}(): ${rp.steps.join(' → ')}`],
    sourceRef: ref(rp.stepSources[1]),
    derivedFrom: 'display.renderPath',
  },
  {
    id: 'oled.ssd1306',
    label: map.display.driverLibrary,
    kind: 'library',
    summary: rp.steps[2],
    detail: [map.display.initCall, map.display.bootFailureImplication],
    sourceRef: ref(rp.stepSources[2]),
    derivedFrom: 'display.driverLibrary + display.renderPath',
  },
  {
    id: 'oled.wire',
    label: 'Wire',
    kind: 'library',
    summary: map.boards
      .filter((b) => b.active)
      .map((b) => `SDA ${b.i2c.sda} / SCL ${b.i2c.scl}`)
      .join(''),
    detail: [
      ...map.boards.map((b) => `${b.id}: SDA ${b.i2c.sda}, SCL ${b.i2c.scl}${b.i2c.commentedOut ? ' (commented out)' : ''}`),
      map.display.busClockNote,
    ],
    sourceRef: ref(map.bootOrder.find((b) => b.subsystem === 'i2c')?.source),
    derivedFrom: 'boards[].i2c + display.busClockNote',
  },
  {
    id: 'oled.i2c',
    label: `I²C ${map.display.i2cAddress}`,
    kind: 'signal',
    summary: `2 wires, address ${map.display.i2cAddress}`,
    detail: [
      `Reset pin ${map.display.resetPin}: ${map.display.resetPinNote}`,
      `Bus clock: ${map.display.busClockHz === null ? 'never set in source' : `${map.display.busClockHz} Hz`}.`,
    ],
    sourceRef: ref(map.display.i2cAddressSource),
    derivedFrom: 'display.i2cAddress',
  },
  {
    id: 'oled.controller',
    label: 'SSD1306 controller',
    kind: 'physical',
    summary: 'page-ordered GDDRAM',
    detail: [
      `${map.display.widthPx}×${map.display.heightPx} panel driven by ${map.display.driverLibrary}.`,
      map.display.bootFailureBehaviour,
    ],
    sourceRef: ref(map.display.initSource),
    derivedFrom: 'display',
  },
  {
    id: 'oled.pixels',
    label: `${map.display.widthPx}×${map.display.heightPx} pixels`,
    kind: 'physical',
    summary: `${map.display.widthPx * map.display.heightPx} monochrome pixels`,
    detail: [`Width source ${map.display.widthSource.file}:${map.display.widthSource.line}.`],
    sourceRef: ref(map.display.widthSource),
    derivedFrom: 'display.widthPx / display.heightPx',
  },
];

oledChain.forEach((spec, i) => {
  node({ ...spec, group: 'face', depth: 3 + i, parent: 'oled', traceLayers: [] });
  edge(i === 0 ? 'oled' : oledChain[i - 1].id, spec.id, { derivedFrom: spec.derivedFrom });
});

// ==================================================== HTTP: the ten routes
map.network.http.routes.forEach((route, i) => {
  const id = `route.${i}`;
  node({
    id,
    label: `${route.method} ${route.path}`,
    kind: 'route',
    group: 'network',
    depth: 3,
    parent: 'http-api',
    summary: route.handlerSymbol,
    detail: [
      route.description,
      route.methodEnforcedInHandler === undefined
        ? `Registered for ${route.method}; the handler enforces nothing further.`
        : `Registered for ${route.method} but the handler rejects non-${route.methodEnforcedInHandler} with 405.`,
      `Content-Type: ${route.contentType ?? '(unset)'}`,
    ],
    sourceRef: ref(route.handlerSource),
    derivedFrom: `network.http.routes[${i}]`,
    traceLayers: route.path === '/api/command' ? ['http.request'] : [],
  });
  edge('http-api', id, { derivedFrom: `network.http.routes[${i}].registrationSource` });
});

// =============================================== serial: UART and the CLI
node({
  id: 'serial.uart0',
  label: `UART0 @ ${map.network.serial.baud}`,
  kind: 'signal',
  group: 'serial',
  depth: 3,
  parent: 'developer',
  summary: `line terminators ${map.network.serial.lineTerminators.join(' ')}`,
  detail: [`Serial.begin(${map.network.serial.baud}) — ${map.bootOrder[0].note}`],
  sourceRef: ref(map.network.serial.baudSource),
  derivedFrom: 'network.serial',
  traceLayers: [],
});

node({
  id: 'serial.cli',
  label: 'serial CLI',
  kind: 'firmware',
  group: 'serial',
  depth: 4,
  parent: 'developer',
  summary: `${map.commands.serialCli.length} forms · ${map.network.serial.cliBufferBytes}-byte buffer`,
  detail: [
    map.commands.serialCliDispatchNote,
    `Examples: ${map.commands.serialCli
      .slice(0, 4)
      .map((c) => c.input.join(' / '))
      .join(' · ')}`,
  ],
  sourceRef: ref(map.network.serial.cliSource?.from),
  derivedFrom: 'commands.serialCli',
  traceLayers: [],
});

edge('developer', 'serial.uart0', { derivedFrom: 'network.serial.baudSource' });
edge('serial.uart0', 'serial.cli', { derivedFrom: 'network.serial.cliSource' });

// ============================================ the 21 movement functions
map.movements.forEach((mv) => {
  const touched = [...new Set(mv.steps.filter((s) => s.type === 'servo').map((s) => s.joint))];
  const ordered = JOINTS.filter((j) => touched.includes(j));
  node({
    id: `movement.${mv.function}`,
    label: mv.function,
    kind: 'movement',
    group: 'movement',
    depth: 2,
    parent: 'movement',
    summary:
      `${mv.kind} · ${mv.steps.length} steps` +
      (ordered.length === 0 ? ' · no servo writes' : ` · ${ordered.join(' ')}`),
    detail: [
      `Triggered by: ${(mv.triggeredByCommand ?? []).join(', ') || '(not a command word)'}`,
      `loops: ${String(mv.loops)} · interruptible: ${String(mv.interruptible)}`,
      `${mv.sourceRange.from.file}:${mv.sourceRange.from.line}–${mv.sourceRange.to.line}`,
    ],
    sourceRef: ref(mv.source),
    derivedFrom: `movements[${mv.function}]`,
    joints: ordered,
    traceLayers: ['movement.enter'],
  });
  edge('movement', `movement.${mv.function}`, {
    derivedFrom: `movements[${mv.function}].triggeredByCommand`,
  });
});

// ================================== the cross-links the flat JSON hides
//
// Both of these are surprising, both are in the data, and neither is visible in
// the report's tree.
edge('servo.setServoAngle', 'face', {
  label: 'delayWithFace() also pumps face, HTTP and DNS',
  derivedFrom: 'servos.servoConfig.setServoAngle.steps[4]',
  note: setter.steps[3].description,
});

const apiCommandIndex = map.network.http.routes.findIndex((r) => r.path === '/api/command');
if (apiCommandIndex < 0) fail('network.http.routes has no /api/command');
edge(`route.${apiCommandIndex}`, 'movement', {
  label: `sets ${map.commands.stateVariable}`,
  derivedFrom: 'commands.setBy',
});
edge('serial.cli', 'movement', {
  label: `sets ${map.commands.stateVariable}`,
  derivedFrom: 'commands.setBy',
});

// ------------------------------------------------------------------- checks
for (const e of edges) {
  if (!nodes.some((n) => n.id === e.source)) fail(`edge ${e.id} has unknown source`);
  if (!nodes.some((n) => n.id === e.target)) fail(`edge ${e.id} has unknown target`);
}
const handAuthored = [
  ...nodes.filter((n) => n.derivation === 'hand-authored').map((n) => `node ${n.id}`),
  ...edges.filter((e) => e.derivation === 'hand-authored').map((e) => `edge ${e.id}`),
];
// The eight MG90S->joint edges are one claim made eight times; count them once.
const handAuthoredClaims = handAuthored.filter((s) => !/^edge servo\.mg90s->joint\.(?!R1$)/.test(s));
if (handAuthoredClaims.length > HAND_AUTHORED_BUDGET) {
  fail(
    `${handAuthoredClaims.length} hand-authored claims exceeds the budget of ${HAND_AUTHORED_BUDGET}:\n  ` +
      handAuthoredClaims.join('\n  '),
  );
}


// ============================================================================
// Facts the "See the Signal" trace needs, projected out of the same JSON.
//
// The trace must not hand-type a single one of these. `wave -> runWavePose` is
// `commands.vocabulary`; the `WAVE` banner the firmware prints on entry is
// `movements[].steps[0]`; the pulse arithmetic is `@sesame-lab/sesame-model`.
// ============================================================================
const movementByFn = Object.fromEntries(map.movements.map((m) => [m.function, m]));

const commandTrace = map.commands.vocabulary
  .filter((v) => typeof v.command === 'string' && v.command.length > 0)
  .map((v) => {
    const mv = v.movementFunction === null ? undefined : movementByFn[v.movementFunction];
    const logStep = mv?.steps.find((s) => s.type === 'log') ?? null;
    const faceStep = mv?.steps.find((s) => s.type === 'face') ?? null;
    const touched = mv === undefined ? [] : [...new Set(mv.steps.filter((s) => s.type === 'servo').map((s) => s.joint))];
    return {
      command: v.command,
      movementFunction: v.movementFunction ?? null,
      movementSourceRef: mv === undefined ? null : ref(mv.source),
      movementSourceRange:
        mv === undefined
          ? null
          : { file: mv.sourceRange.from.file, from: mv.sourceRange.from.line, to: mv.sourceRange.to.line },
      commandSourceRef: ref(v.source),
      logBanner: logStep === null ? null : logStep.text,
      logBannerSourceRef: logStep === null ? null : ref(logStep.source),
      faceOnEntry: faceStep === null ? null : faceStep.name,
      joints: JOINTS.filter((jn) => touched.includes(jn)),
      servoStepCount: mv === undefined ? 0 : mv.steps.filter((s) => s.type === 'servo').length,
      stepCount: mv === undefined ? 0 : mv.steps.length,
      continuous: v.continuous === true,
      clearsSelf: v.clearsSelf === true,
    };
  });

const apiRoute = map.network.http.routes[apiCommandIndex];
const httpCommandRoute = {
  nodeId: `route.${apiCommandIndex}`,
  path: apiRoute.path,
  registeredMethod: apiRoute.method,
  enforcedMethod: apiRoute.methodEnforcedInHandler ?? null,
  handlerSymbol: apiRoute.handlerSymbol,
  sourceRef: ref(apiRoute.handlerSource),
  description: apiRoute.description,
  port: map.network.http.port,
  tls: map.network.http.tls,
  authentication: map.network.http.authentication,
};

const pwmFacts = {
  nodeId: 'servo.ledc',
  frequencyHz: cfg.pwmFrequencyHz,
  timerWidthBits: q.timerWidthBits,
  usPerTick: q.usPerTick,
  minTick: q.minTick,
  maxTick: q.maxTick,
  commandableAngles: q.commandableAngles,
  distinctReachablePulseValues: q.distinctReachablePulseValues,
  aliasedAngleCount: q.aliasedAngleCount,
  attachCall: cfg.attachCall,
  requestedMaxUs: cfg.attachPulseClamp.requestedMaxUs,
  effectiveMaxUs: cfg.attachPulseClamp.effectiveMaxUs,
  channelsProgrammed: cfg.ledcChannelsProgrammed,
  speedGroupsUsed: cfg.ledcSpeedGroupsUsed,
  channelPerJointKnown: false,
  sourceRef: ref(cfg.pwmFrequencySource),
};

const setServoAngleFacts = {
  nodeId: 'servo.setServoAngle',
  symbol: setter.symbol,
  signature: setter.signature,
  sourceRef: ref(setter.source),
  clampStep: setter.steps[1].description,
  writeStep: setter.steps[2].description,
  positionFeedbackNote: setter.positionFeedbackNote,
};

const boardPins = Object.fromEntries(
  map.boards.map((b) => [
    b.id,
    Object.fromEntries(
      JOINTS.map((jn) => [jn, map.servos.joints.find((x) => x.firmwareName === jn).pinsByBoard[b.id]]),
    ),
  ]),
);

const jointFacts = Object.fromEntries(
  JOINTS.map((jn) => {
    const hw = map.servos.joints.find((x) => x.firmwareName === jn);
    const jm = jointEntry(jn);
    return [
      jn,
      {
        nodeId: `joint.${jn}`,
        firmwareIndex: hw.index,
        kind: jm?.kind ?? null,
        semanticName: jm?.semanticName?.value ?? null,
        semanticNameVerified: jm?.semanticName?.verified === true,
        sourceRef: ref(hw.source),
      },
    ];
  }),
);

// -------------------------------------------------------------------- emit
const L = [];
const emit = (s = '') => L.push(s);
const j = (v) => JSON.stringify(v);

emit('/**');
emit(' * GENERATED by apps/web/scripts/build-architecture-graph.mjs — do not edit.');
emit(' *');
emit(' * Every node and edge below is projected out of `hardware/hardware-map.json`');
emit(' * (and `hardware/joint-map.json` for joint kinds and spatial names). Each one');
emit(' * carries `derivedFrom`, the path it came from, and `sourceRef`, the firmware');
emit(' * `file:line` that JSON itself cites.');
emit(' *');
emit(` * ${nodes.length} nodes, ${edges.length} edges, ${handAuthoredClaims.length} hand-authored claims.`);
emit(' *');
emit(' * Regenerate: node apps/web/scripts/build-architecture-graph.mjs');
emit(' * Check:      node apps/web/scripts/build-architecture-graph.mjs --check');
emit(' */');
emit('');
emit('/** A firmware location, as `hardware-map.json` cites it. */');
emit('export interface ArchSourceRef {');
emit('  /** Path relative to the upstream repo root. */');
emit('  readonly file: string;');
emit('  readonly line: number;');
emit('}');
emit('');
emit('/**');
emit(' * `derived` — projected from a field of `hardware-map.json`.');
emit(' * `hand-authored` — a claim the data cannot express. Rendered with a marker.');
emit(' */');
emit("export type ArchDerivation = 'derived' | 'hand-authored';");
emit('');
emit('export type ArchNodeKind =');
emit(
  '  ' +
    [...new Set(nodes.map((n) => n.kind))]
      .sort()
      .map((k) => `| ${j(k)}`)
      .join('\n  '),
);
emit(';');
emit('');
emit('export interface ArchNode {');
emit('  readonly id: string;');
emit('  readonly label: string;');
emit('  readonly kind: ArchNodeKind;');
emit('  /** Top-level branch: which of the four setup() concerns this belongs to. */');
emit('  readonly group: string;');
emit('  /** Distance from `esp32` along the chain. Drives layout rows. */');
emit('  readonly depth: number;');
emit('  /** The node whose expansion reveals this one. `null` = visible when collapsed. */');
emit('  readonly parent: string | null;');
emit('  readonly summary: string;');
emit('  readonly detail: readonly string[];');
emit('  readonly sourceRef: ArchSourceRef | null;');
emit('  readonly derivation: ArchDerivation;');
emit('  /** Path into hardware-map.json. Shown verbatim in the inspector. */');
emit('  readonly derivedFrom: string;');
emit('  /** `hardware-map.json -> unresolved[].id` when the value is not known. */');
emit('  readonly unresolved: string | null;');
emit('  /** Joints this node is about. Drives cross-pane highlighting. */');
emit('  readonly joints: readonly string[];');
emit('  /** "See the Signal" layers whose rows belong to this node. */');
emit('  readonly traceLayers: readonly string[];');
emit('}');
emit('');
emit('export interface ArchEdge {');
emit('  readonly id: string;');
emit('  readonly source: string;');
emit('  readonly target: string;');
emit('  readonly label: string | null;');
emit('  readonly derivation: ArchDerivation;');
emit('  readonly derivedFrom: string;');
emit('  readonly note: string | null;');
emit('}');
emit('');
emit('/** The upstream commit every `sourceRef` above points into. */');
emit(`export const UPSTREAM_COMMIT = ${j(map.meta.sourceTree.upstreamCommit)} as const;`);
emit('');
emit('/** Visible before anything is expanded — the report’s collapsed top level. */');
emit(
  `export const ROOT_NODE_IDS: readonly string[] = ${j(nodes.filter((n) => n.parent === null).map((n) => n.id))};`,
);
emit('');
emit('/** Nodes with children, i.e. the ones a click can expand. */');
emit(
  `export const EXPANDABLE_NODE_IDS: readonly string[] = ${j([
    ...new Set(nodes.filter((n) => n.parent !== null).map((n) => n.parent)),
  ])};`,
);
emit('');
emit('/** Left-to-right order of the four branches under ESP32. */');
emit(`export const GROUP_ORDER: readonly string[] = ${j(['movement', 'face', 'network', 'serial'])};`);
emit('');
emit('export const ARCH_NODES: readonly ArchNode[] = [');
for (const n of nodes) emit(`  ${j(n)},`);
emit('];');
emit('');
emit('export const ARCH_EDGES: readonly ArchEdge[] = [');
for (const e of edges) emit(`  ${j(e)},`);
emit('];');
emit('');
emit('/**');
emit(' * Claims no artefact in this repository establishes.');
emit(' *');
emit(' * Kept as data rather than prose so the UI can mark them and a test can');
emit(' * assert the list has not silently grown.');
emit(' */');
emit(`export const HAND_AUTHORED: readonly string[] = ${j(handAuthoredClaims)};`);
emit('');
emit('/** By id, for O(1) lookup from the trace and the 3D scene. */');
emit('export const ARCH_NODE_BY_ID: ReadonlyMap<string, ArchNode> = new Map(');
emit('  ARCH_NODES.map((n) => [n.id, n]),');
emit(');');
emit('');

emit('/**');
emit(' * One command word, with everything the trace needs to explain it.');
emit(' *');
emit(' * `logBanner` is what the firmware actually prints on entry - the first');
emit(' * `log` step of the movement function. It is how `movement.enter` can be');
emit(' * OBSERVED rather than asserted: under QEMU the guest really writes it to');
emit(' * UART0, and the simulator emits the same string from the same extracted');
emit(' * step, so one row works on both backends and says which it got.');
emit(' */');
emit('export interface CommandTraceFacts {');
emit('  readonly command: string;');
emit('  readonly movementFunction: string | null;');
emit('  readonly movementSourceRef: ArchSourceRef | null;');
emit('  readonly movementSourceRange: { readonly file: string; readonly from: number; readonly to: number } | null;');
emit('  readonly commandSourceRef: ArchSourceRef | null;');
emit('  readonly logBanner: string | null;');
emit('  readonly logBannerSourceRef: ArchSourceRef | null;');
emit('  readonly faceOnEntry: string | null;');
emit('  readonly joints: readonly string[];');
emit('  readonly servoStepCount: number;');
emit('  readonly stepCount: number;');
emit('  readonly continuous: boolean;');
emit('  readonly clearsSelf: boolean;');
emit('}');
emit('');
emit(`export const COMMAND_TRACE_FACTS: readonly CommandTraceFacts[] = ${j(commandTrace)};`);
emit('');
emit('export const COMMAND_TRACE_BY_NAME: ReadonlyMap<string, CommandTraceFacts> = new Map(');
emit('  COMMAND_TRACE_FACTS.map((c) => [c.command, c]),');
emit(');');
emit('');
emit('/** `POST /api/command` - the route the report\u2019s `http.request` row names. */');
emit(`export const HTTP_COMMAND_ROUTE = ${j(httpCommandRoute)} as const;`);
emit('');
emit('/**');
emit(' * What the LEDC peripheral is, and the one thing nobody here knows about it.');
emit(' *');
emit(' * `channelPerJointKnown` is `false` and is not a placeholder. Q3 read the');
emit(' * register file back over QEMU\u2019s gdbstub and established WHICH eight');
emit(' * channels are programmed; no artefact in this repository says which of them');
emit(' * carries which servo. The report\u2019s example row prints `channel=6`. This');
emit(' * app prints no channel number at all.');
emit(' */');
emit(`export const PWM_FACTS = ${j(pwmFacts)} as const;`);
emit('');
emit('/** The single convergence point every servo write passes through. */');
emit(`export const SET_SERVO_ANGLE_FACTS = ${j(setServoAngleFacts)} as const;`);
emit('');
emit('/** GPIO pin per joint per board. Exactly one board is active at a time. */');
emit(`export const SERVO_PINS_BY_BOARD: Readonly<Record<string, Readonly<Record<string, number>>>> = ${j(boardPins)};`);
emit('');
emit(`export const ACTIVE_BOARD_ID = ${j(activeBoard.id)} as const;`);
emit('');
emit('/**');
emit(' * How `origin.board` spells a board vs how `hardware-map.json` spells it.');
emit(' *');
emit(' * `QemuSesameRobot` stamps `distro-v1-esp32`; the map calls it `distro-v1`.');
emit(' * Without this the trace would silently fall back to the active board and');
emit(' * print S2-Mini pin numbers beside an ESP32 run.');
emit(' */');
emit(
  'export const ORIGIN_BOARD_ALIASES: Readonly<Record<string, string>> = ' +
    j({ 'distro-v1-esp32': 'distro-v1', 'distro-v3-s3': 'distro-v3', s2mini: 's2-mini' }) +
    ';',
);
emit('');
emit('/** Per-joint identity: the servo channel is authoritative, the name is not. */');
emit('export interface JointFacts {');
emit('  readonly nodeId: string;');
emit('  readonly firmwareIndex: number;');
emit('  readonly kind: string | null;');
emit('  readonly semanticName: string | null;');
emit('  readonly semanticNameVerified: boolean;');
emit('  readonly sourceRef: ArchSourceRef | null;');
emit('}');
emit('');
emit(`export const JOINT_FACTS: Readonly<Record<string, JointFacts>> = ${j(jointFacts)};`);
emit('');

const body = L.join('\n');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
const summary = `${nodes.length} nodes, ${edges.length} edges, ${handAuthoredClaims.length} hand-authored`;

if (check) {
  if (existing === body) {
    console.log(`OK    architecture-graph.ts matches hardware/hardware-map.json — ${summary}`);
    process.exit(0);
  }
  console.error('FAIL  apps/web/src/generated/architecture-graph.ts is stale relative to hardware/hardware-map.json.');
  console.error('      Regenerate: node apps/web/scripts/build-architecture-graph.mjs');
  process.exit(1);
}

fs.writeFileSync(OUT, body);
console.log(`WROTE ${path.relative(REPO, OUT).replaceAll('\\', '/')} — ${summary}`);

function fail(msg) {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}
