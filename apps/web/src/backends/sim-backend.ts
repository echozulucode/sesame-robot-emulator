/**
 * Backend 1 — `SimulatedSesameRobot`, in-process.
 *
 * No wire, no server, no build step between the model and the scene. This is
 * the default because it is the only backend that can be *driven*: the buttons
 * work, a wave really executes 395 steps of extracted choreography, and every
 * event it emits is tagged `simulated` by the model itself.
 *
 * The one configuration choice worth naming is `timeMode: 'realtime'`. V1's
 * default is virtual time, where a 3.7-second wave completes in under a
 * millisecond — correct for tests, useless for a robot you are meant to watch.
 * Realtime is not a second implementation: `driveRealtime()` is a pacer around
 * the same generator, sleeping at each cooperative pump. So the browser sees
 * the firmware's own timing, `motorCurrentDelay` and all, and the event stream
 * is identical to the one the tests assert on.
 */
import type { JointName, SesameCapabilities } from '@sesame-lab/sesame-model';
import type { SesameTelemetry } from '@sesame-lab/sesame-protocol';
import { SimulatedSesameRobot, type SimulatedRobotState } from '@sesame-lab/sesame-sim';

import type { BackendStatus, TelemetryBackend } from './types.js';

export interface SimBackendOptions {
  /** Wall-clock multiplier. 1 = the robot's own speed. */
  readonly speed?: number;
}

export class SimBackend implements TelemetryBackend {
  readonly id = 'sim' as const;
  readonly label = 'Simulated (in-process)';
  readonly description =
    'A host-side behaviour model of the firmware — @sesame-lab/sesame-sim — running in this tab. ' +
    'All 21 movements come from the 395 choreography steps extracted from firmware source. ' +
    'No firmware executes and no silicon is involved.';
  readonly expectedProvenance = 'simulated' as const;
  readonly canCommand = true;
  readonly commandUnavailableReason = null;

  readonly #robot: SimulatedSesameRobot;
  readonly #eventListeners = new Set<(event: SesameTelemetry) => void>();
  readonly #statusListeners = new Set<(status: BackendStatus) => void>();
  #unsubscribe: (() => void) | null = null;
  #status: BackendStatus = { connection: 'idle', detail: 'not started', eventsReceived: 0 };

  constructor(options: SimBackendOptions = {}) {
    this.#robot = new SimulatedSesameRobot(
      { timeMode: 'realtime' },
      { speed: options.speed ?? 1 },
    );
  }

  /** The model itself, for the inspector and the browser test hook. */
  get robot(): SimulatedSesameRobot {
    return this.#robot;
  }

  get status(): BackendStatus {
    return this.#status;
  }

  async start(): Promise<void> {
    if (this.#unsubscribe !== null) return;
    this.#setStatus({ connection: 'connecting', detail: 'powering on the model', eventsReceived: 0 });
    this.#unsubscribe = this.#robot.subscribe((event) => {
      this.#status = { ...this.#status, eventsReceived: this.#status.eventsReceived + 1 };
      for (const listener of this.#eventListeners) listener(event);
    });
    // connect() reproduces setup(): the hello line, then setFace("rest") with
    // no servo writes at all ("Show rest face on startup without moving
    // motors", ino:746). Nothing here commands a joint, so `everCommanded` is
    // false on all eight until the user does something.
    await this.#robot.connect();
    this.#setStatus({
      connection: 'connected',
      detail: 'model running on virtual time, paced to wall clock',
      eventsReceived: this.#status.eventsReceived,
    });
  }

  async stop(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.#robot.disconnect();
    this.#setStatus({ connection: 'closed', detail: 'model disconnected', eventsReceived: this.#status.eventsReceived });
  }

  onEvent(listener: (event: SesameTelemetry) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  onStatus(listener: (status: BackendStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async command(name: string): Promise<void> {
    await this.#robot.command(name);
  }

  async setFace(name: string): Promise<void> {
    await this.#robot.setFace(name);
  }

  async setJoint(joint: JointName, angleDeg: number): Promise<void> {
    await this.#robot.setJoint(joint, angleDeg);
  }

  /** Clears `currentCommand` synchronously, the way `/cmd?stop=` does. */
  stopMotion(): void {
    this.#robot.stop();
  }

  modelState(): Promise<SimulatedRobotState | null> {
    return this.#robot.getState();
  }

  capabilities(): Promise<SesameCapabilities | null> {
    return this.#robot.capabilities();
  }

  #setStatus(status: BackendStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }
}
