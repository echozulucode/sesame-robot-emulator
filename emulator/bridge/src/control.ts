/**
 * The host → device control channel — **off by default, and loopback only.**
 *
 * ## Why this file has more prose than code
 *
 * The WebSocket hub used to end with:
 *
 * ```ts
 * // v1 is device -> host only. Anything a client sends is discarded rather
 * // than interpreted: this port must not become an accidental control API.
 * socket.on('message', () => undefined);
 * ```
 *
 * That was a deliberate safety property, not an omission, and protocol v2
 * giving the wire a host → device direction is not on its own a reason to
 * delete it. The reasoning behind the original line is all still true:
 *
 * - the telemetry port has **no authentication of any kind**, and never has;
 * - it is a *fan-out* port, so every viewer that can read the stream would also
 *   be able to drive the robot;
 * - `--allow-remote` exists and people use it, which means "anyone who can
 *   reach this port" is not always "someone at this keyboard";
 * - and a viewer is a *debug* client. Nothing in `debug-viewer/` or `apps/web`
 *   needs to send, so enabling it by default would widen the attack surface for
 *   a capability nobody had asked for.
 *
 * So the discard stays as the default, and control is an explicit opt-in with
 * three properties that are enforced here rather than documented and hoped for:
 *
 * 1. **Off unless `--allow-control`.** With it off, `handleControlMessage` is
 *    never called and the message is discarded exactly as before.
 * 2. **Loopback only, checked per connection**, not per configuration.
 *    `--allow-control` and `--allow-remote` together are refused at startup,
 *    and even so every message is re-checked against the peer address, because
 *    a bind address is not a guarantee about who connected.
 * 3. **Nothing arbitrary reaches the UART.** A control message names a
 *    {@link SesameCommand}; `encodeCommand` turns it into a line that has been
 *    checked against the firmware's dispatch chain and its 31-byte buffer.
 *    There is no "send this raw text" escape hatch, so a client cannot craft a
 *    line that lands on a branch the type system never described.
 *
 * Every accepted and every rejected command is announced on the telemetry
 * stream itself as an `emulator`-channel log. That is the audit trail: if a
 * robot moves, the reason is in the same stream as the movement.
 */
import {
  CommandEncodeError,
  encodeCommand,
  type EncodedCommand,
  type SesameCommand,
} from '@sesame-lab/sesame-protocol';

/** Envelope a control client sends. */
export interface ControlMessage {
  /** Must be 2. v1 had no host -> device direction to be compatible with. */
  readonly v: 2;
  readonly type: 'command';
  readonly command: SesameCommand;
}

/** What the bridge decided to do with one. */
export type ControlOutcome =
  | { readonly ok: true; readonly encoded: EncodedCommand }
  | { readonly ok: false; readonly reason: string };

/** Loopback, in every spelling Node hands back from `socket.remoteAddress`. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * True for a peer on this machine.
 *
 * `undefined` is treated as **not** loopback. A destroyed socket reports no
 * remote address, and defaulting an unknown peer to "trusted" is the wrong way
 * round for a check whose entire job is to refuse.
 */
export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_ADDRESSES.has(remoteAddress);
}

/**
 * Validate one client message and turn it into a line for UART0.
 *
 * Pure: it decides, it does not send. That is what makes the policy testable
 * without a socket, and it is why the peer address is a parameter rather than
 * something this function goes looking for.
 */
export function decodeControlMessage(
  raw: string,
  remoteAddress: string | undefined,
): ControlOutcome {
  if (!isLoopbackPeer(remoteAddress)) {
    return { ok: false, reason: `control refused: peer ${remoteAddress ?? 'unknown'} is not loopback` };
  }
  if (raw.length > 4096) {
    return { ok: false, reason: 'control refused: message too large' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'control refused: not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'control refused: not an object' };
  }

  const message = parsed as Partial<ControlMessage>;
  if (message.v !== 2) {
    return { ok: false, reason: `control refused: expected v:2, got ${JSON.stringify(message.v)}` };
  }
  if (message.type !== 'command') {
    return { ok: false, reason: `control refused: unknown type ${JSON.stringify(message.type)}` };
  }
  const command = message.command;
  if (typeof command !== 'object' || command === null || typeof command.type !== 'string') {
    return { ok: false, reason: 'control refused: command must be a SesameCommand' };
  }

  try {
    // The narrowing gate. `encodeCommand` rejects an unknown verb, a bad joint,
    // an out-of-range angle and anything that would overflow `command_buffer` —
    // and it verifies the result against the dispatch chain before returning
    // it, so what reaches the wire is a line whose branch is known.
    return { ok: true, encoded: encodeCommand(command as SesameCommand) };
  } catch (error) {
    if (error instanceof CommandEncodeError) {
      return { ok: false, reason: `control refused (${error.code}): ${error.message}` };
    }
    return { ok: false, reason: `control refused: ${String(error)}` };
  }
}
