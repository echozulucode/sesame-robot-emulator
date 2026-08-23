/**
 * Read the argument registers at an Xtensa `call8` site out of `objdump -d`
 * output.
 *
 * This exists for one question, and it is not an academic one: **which serial
 * port does a telemetry `printf` actually write to?**
 *
 * R4 found that the first cut of `firmware/patches/telemetry-instrumentation.patch`
 * emitted on `Serial`, which Arduino-ESP32 aliases at compile time to a USB CDC
 * endpoint on two of the three board profiles. The firmware compiled, linked,
 * and contained every format string in the right section — and the bytes left
 * through an endpoint nothing on the host was reading. Checking that a string is
 * present in the binary is completely blind to that class of defect. Checking
 * the `this` pointer at the call site is not.
 *
 * Xtensa windowed ABI: `call8` passes arg0 in a10, arg1 in a11, and so on.
 * Reading the two `l32r`s nearest the call is not enough, because the compiler
 * keeps a live pointer in a callee-saved register and forwards it — which
 * happens for real in this firmware, inside `setup()`:
 *
 *     40084f8b:  l32r  a7, ... (3ffca168 <Serial0>)
 *     ...        0x25 bytes of unrelated work
 *     40084fb5:  mov.n a10, a7
 *     40084fba:  call8 ... <Print::printf(char const*, ...)>
 *
 * So {@link resolveArgRegister} walks backwards through the function following
 * `l32r`, `mov.n` and the canonical `or aX, aY, aY` move until it reaches a
 * literal pool entry.
 *
 * Deliberately kept dependency-free and pure so it can be unit-tested against
 * captured disassembly on a machine with no toolchain — including a capture of
 * the defective build, which is the only way to know the check can actually
 * fail.
 */

const L32R = /\bl32r\s+a(\d+),.*\(([0-9a-f]+)\b/;
const MOVN = /\bmov\.n\s+a(\d+),\s*a(\d+)/;
const OR = /\bor\s+a(\d+),\s*a(\d+),\s*a(\d+)/;
const LABEL = /^[0-9a-f]+ <.*>:$/;
const SITE_ADDR = /^\s*([0-9a-f]+):/;

/** Both the demangled (`objdump -C`) and raw spellings of `Print::printf`. */
export const PRINTF_CALL = /call8\s+[0-9a-f]+\s+<(?:Print::printf\b|_ZN5Print6printfEPKcz)/;

/**
 * Value last written to `reg` before line `from`, or null if it cannot be
 * resolved within the enclosing function.
 *
 * @param {readonly string[]} lines  objdump -d output, split into lines
 * @param {number} from              index of the call instruction
 * @param {number} reg               register number (10 = arg0, 11 = arg1)
 * @param {number} [maxHops]         how many move-forwards to follow
 * @returns {number | null}          the literal address, or null
 */
export function resolveArgRegister(lines, from, reg, maxHops = 4) {
  const walk = (start, target, hops) => {
    if (hops > maxHops) return null;
    for (let i = start - 1; i >= 0 && i > start - 200; i--) {
      const line = lines[i] ?? '';
      // Stop at the function's own label: a value defined in the previous
      // function is not this function's value.
      if (LABEL.test(line.trim())) return null;

      const l = L32R.exec(line);
      if (l && Number(l[1]) === target) return parseInt(l[2], 16);

      const m = MOVN.exec(line);
      if (m && Number(m[1]) === target) return walk(i, Number(m[2]), hops + 1);

      const o = OR.exec(line);
      if (o && Number(o[1]) === target && o[2] === o[3]) return walk(i, Number(o[2]), hops + 1);
    }
    return null;
  };
  return walk(from, reg, 0);
}

/**
 * Every `Print::printf` call whose format argument is one of `formatVmas`.
 *
 * @param {readonly string[]} lines            objdump -d output
 * @param {Map<number, string>} formatVmas     format-string address -> literal
 * @param {Map<number, string>} serialSymbols  object address -> symbol name
 * @returns {{literal: string, callSite: string, formatVma: string, port: string | null}[]}
 */
export function findTelemetryPrintfSites(lines, formatVmas, serialSymbols) {
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!PRINTF_CALL.test(line)) continue;

    const format = resolveArgRegister(lines, i, 11);
    if (format === null || !formatVmas.has(format)) continue; // not a telemetry call

    const portAddr = resolveArgRegister(lines, i, 10);
    sites.push({
      literal: formatVmas.get(format),
      callSite: `0x${(SITE_ADDR.exec(line) ?? [, '?'])[1]}`,
      formatVma: `0x${format.toString(16)}`,
      port:
        portAddr === null
          ? null
          : (serialSymbols.get(portAddr) ?? `0x${portAddr.toString(16)}`),
    });
  }
  return sites;
}
