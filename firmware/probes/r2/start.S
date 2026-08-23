/* R2 probe startup for ESP32-S2 (Xtensa LX7).
 *
 * Deliberately mirrors what the ESP-IDF reset path does, and nothing else:
 * initialise the register window, set PS, set a stack, zero .bss, call C.
 *
 * Two builds come out of this one file:
 *   default            -> windowed ABI  (PS.WOE = 1, VECBASE installed)
 *   -DPROBE_CALL0      -> call0 ABI     (PS.WOE = 0, no window vectors)
 *
 * Progress markers are written to the fixed result mailbox at 0x3FFD0000 so
 * that a run which dies inside startup can still be located to the exact step.
 */

    .section .entry.text, "ax"
    .literal_position
    .literal .Lresults,  0x3FFD0000
    .literal .Lstack,    _stack_top
    .literal .Lbss_s,    _bss_start
    .literal .Lbss_e,    _bss_end
    .literal .Lps_woe,   0x00040020      /* PS: WOE(bit18) | UM(bit5), INTLEVEL=0 */
    .literal .Lps_call0, 0x00000020      /* PS: UM only, WOE clear */
    .literal .Lvecbase,  _vecbase

    .align  4
    .global _start
    .type   _start, @function
_start:
    /* --- marker 1: fetch/execute works at all, l32r + s32i work ---------- */
    l32r    a2, .Lresults
    movi    a3, 1
    s32i    a3, a2, 0

#ifndef PROBE_CALL0
    /* --- window registers: WindowBase = 0, WindowStart = 1 -------------- */
    movi    a3, 0
    wsr.windowbase a3
    rsync
    movi    a3, 1
    wsr.windowstart a3
    rsync
    l32r    a2, .Lresults          /* a2 may have been clobbered by the rotate */
    movi    a3, 2
    s32i    a3, a2, 4

    /* --- exception vector base ------------------------------------------ */
    l32r    a3, .Lvecbase
    wsr.vecbase a3
    isync

    /* --- PS ------------------------------------------------------------- */
    l32r    a3, .Lps_woe
#else
    movi    a3, 2
    s32i    a3, a2, 4
    l32r    a3, .Lps_call0
#endif
    wsr.ps  a3
    rsync
    l32r    a2, .Lresults
    movi    a3, 3
    s32i    a3, a2, 8

    /* --- stack ---------------------------------------------------------- */
    l32r    a1, .Lstack

    /* --- zero .bss ------------------------------------------------------- */
    l32r    a4, .Lbss_s
    l32r    a5, .Lbss_e
    movi    a6, 0
.Lbss_loop:
    bgeu    a4, a5, .Lbss_done
    s32i    a6, a4, 0
    addi    a4, a4, 4
    j       .Lbss_loop
.Lbss_done:

    l32r    a2, .Lresults
    movi    a3, 4
    s32i    a3, a2, 12

    /* --- into compiled C ------------------------------------------------- */
    movi    a0, 0
#ifdef PROBE_CALL0
    call0   probe_main
#else
    call4   probe_main
#endif

    l32r    a2, .Lresults
    movi    a3, 5
    s32i    a3, a2, 16

    .global _probe_done
_probe_done:
    j       _probe_done
    .size   _start, . - _start
