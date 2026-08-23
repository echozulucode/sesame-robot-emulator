/* The special/user registers the REAL Arduino-ESP32 3.3.11 runtime touches.
 *
 * Every entry below was harvested by disassembling the real, linked Sesame S2
 * firmware (firmware/artifacts/s2mini/sesame-firmware-main.ino.elf, 135,118
 * instructions, 205 distinct mnemonics) and counting rsr./wsr./xsr./rur./wur.
 * operands. Nothing here is speculative: if it is in this list, compiled ESP-IDF
 * code executes it.
 *
 * X(idx, name, mode, testval)
 *   mode  R  = architecturally read-only: probe with rsr only
 *         W  = write-only: probe with wsr only, no read-back possible
 *         RW = probe with wsr then rsr and compare
 *         RWB = read, write the value straight back, read again (for registers
 *               where an arbitrary value would break the running probe)
 *
 * The `uses` comment is the occurrence count in the real firmware.
 */
#ifndef R2_SR_LIST_H
#define R2_SR_LIST_H

#define R2_SR_TABLE(X)                                                   \
    X( 0, ps,            RWB, 0)             /* 20 wsr / 13 rsr        */ \
    X( 1, epc1,          RW,  0x40024444u)   /*  5 wsr /  8 rsr        */ \
    X( 2, excsave1,      RW,  0x1111AAAAu)   /*  4 wsr /  6 rsr        */ \
    X( 3, windowbase,    R,   0)             /*  2 wsr /  5 rsr        */ \
    X( 4, windowstart,   R,   0)             /*  4 wsr /  2 rsr        */ \
    X( 5, intenable,     RW,  0x00000000u)   /*  3 wsr /  5 rsr        */ \
    X( 6, ccount,        R,   0)             /*  1 wsr /  5 rsr        */ \
    X( 7, exccause,      RW,  0x0000001Cu)   /*  3 wsr /  5 rsr        */ \
    X( 8, prid,          R,   0)             /*  5 rsr                 */ \
    X( 9, interrupt,     R,   0)             /*  4 rsr                 */ \
    X(10, intclear,      W,   0xFFFFFFFFu)   /*  4 wsr                 */ \
    X(11, epc2,          RW,  0x40024448u)   /*  1 wsr /  4 rsr        */ \
    X(12, epc3,          RW,  0x4002444Cu)   /*  1 wsr /  3 rsr        */ \
    X(13, epc4,          RW,  0x40024450u)   /*  1 wsr /  2 rsr        */ \
    X(14, epc6,          RW,  0x40024458u)   /*  1 rsr                 */ \
    X(15, eps2,          RW,  0x00040023u)   /*  1 wsr /  1 rsr        */ \
    X(16, eps3,          RW,  0x00040024u)   /*  1 wsr /  2 rsr        */ \
    X(17, excvaddr,      R,   0)             /*  3 rsr                 */ \
    X(18, excsave2,      RW,  0x2222AAAAu)   /*  2 wsr /  2 rsr        */ \
    X(19, excsave3,      RW,  0x3333AAAAu)   /*  2 wsr /  2 rsr        */ \
    X(20, excsave4,      RW,  0x4444AAAAu)   /*  1 wsr /  3 rsr        */ \
    X(21, excsave5,      RW,  0x5555AAAAu)   /*  1 wsr /  1 rsr        */ \
    X(22, excsave6,      RW,  0x6666AAAAu)   /*  1 wsr /  1 rsr        */ \
    X(23, excsave7,      RW,  0x7777AAAAu)   /*  1 wsr /  1 rsr        */ \
    X(24, sar,           RW,  0x00000013u)   /*  1 wsr /  3 rsr        */ \
    X(25, vecbase,       RWB, 0)             /*  1 wsr                 */ \
    X(26, ccompare0,     RW,  0x7FFFFFFFu)   /*  2 wsr /  1 rsr        */ \
    X(27, litbase,       R,   0)             /*  1 rsr                 */ \
    X(28, memctl,        RWB, 0)             /*  1 wsr                 */ \
    X(29, mmid,          W,   0x000000A5u)   /*  1 wsr                 */ \
    X(30, debugcause,    R,   0)             /*  1 rsr                 */ \
    X(31, ibreakenable,  RW,  0x00000000u)   /*  2 wsr /  1 rsr        */ \
    X(32, ibreaka0,      RW,  0x40024460u)   /*  3 xsr                 */ \
    X(33, ibreaka1,      RW,  0x40024464u)   /*  1 wsr                 */ \
    X(34, dbreaka0,      RW,  0x3FFD0F00u)   /*  1 wsr                 */ \
    X(35, dbreaka1,      RW,  0x3FFD0F04u)   /*  2 wsr                 */ \
    X(36, dbreakc0,      RW,  0x00000000u)   /*  1 wsr                 */ \
    X(37, dbreakc1,      RW,  0x00000000u)   /*  2 wsr /  3 rsr        */ \
    /* not in the Sesame image, but architecturally required by anything that  \
       uses C11 atomics, FreeRTOS TLS or a coprocessor. Probed for completeness */ \
    X(39, cpenable,      RW,  0x00000000u)                                \
    X(40, configid0,     R,   0)                                          \
    X(42, misc0,         RW,  0x0C0FFEE0u)                                \
    X(43, ccompare1,     RW,  0x7FFFFFF1u)                                \
    X(44, ccompare2,     RW,  0x7FFFFFF2u)

/* User registers (rur/wur), separate opcode space from rsr/wsr. */
#define R2_UR_TABLE(X)                                                    \
    X( 0, threadptr,     RW,  0x3FFD0E00u)   /*  2 wur /  2 rur        */

#endif /* R2_SR_LIST_H */
