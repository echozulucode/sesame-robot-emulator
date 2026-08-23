/* Xtensa register-window overflow/underflow vector table.
 *
 * Instruction-for-instruction identical to the handlers Espressif's own linked
 * ESP32-S2 image contains: verified by disassembling
 * firmware/artifacts/s2mini/sesame-firmware-main.ino.elf, section
 * .iram0.vectors at 0x40024000 (_WindowOverflow4 .. _WindowUnderflow12).
 *
 * Vector spacing is fixed by the architecture: VECBASE + 0x000/0x040/0x080/
 * 0x0C0/0x100/0x140.
 */

    .section .WindowVectors.text, "ax"

    .global _WindowOverflow4
    .align  4
_WindowOverflow4:
    s32e    a0, a5, -16
    s32e    a1, a5, -12
    s32e    a2, a5, -8
    s32e    a3, a5, -4
    rfwo

    .org    0x40
    .global _WindowUnderflow4
_WindowUnderflow4:
    l32e    a0, a5, -16
    l32e    a1, a5, -12
    l32e    a2, a5, -8
    l32e    a3, a5, -4
    rfwu

    .org    0x80
    .global _WindowOverflow8
_WindowOverflow8:
    s32e    a0, a9, -16
    l32e    a0, a1, -12
    s32e    a1, a9, -12
    s32e    a2, a9, -8
    s32e    a3, a9, -4
    s32e    a4, a0, -32
    s32e    a5, a0, -28
    s32e    a6, a0, -24
    s32e    a7, a0, -20
    rfwo

    .org    0xC0
    .global _WindowUnderflow8
_WindowUnderflow8:
    l32e    a0, a9, -16
    l32e    a1, a9, -12
    l32e    a2, a9, -8
    l32e    a7, a1, -12
    l32e    a3, a9, -4
    l32e    a4, a7, -32
    l32e    a5, a7, -28
    l32e    a6, a7, -24
    l32e    a7, a7, -20
    rfwu

    .org    0x100
    .global _WindowOverflow12
_WindowOverflow12:
    s32e    a0,  a13, -16
    l32e    a0,  a1,  -12
    s32e    a1,  a13, -12
    s32e    a2,  a13, -8
    s32e    a3,  a13, -4
    s32e    a4,  a0,  -48
    s32e    a5,  a0,  -44
    s32e    a6,  a0,  -40
    s32e    a7,  a0,  -36
    s32e    a8,  a0,  -32
    s32e    a9,  a0,  -28
    s32e    a10, a0,  -24
    s32e    a11, a0,  -20
    rfwo

    .org    0x140
    .global _WindowUnderflow12
_WindowUnderflow12:
    l32e    a0,  a13, -16
    l32e    a1,  a13, -12
    l32e    a2,  a13, -8
    l32e    a11, a1,  -12
    l32e    a3,  a13, -4
    l32e    a4,  a11, -48
    l32e    a5,  a11, -44
    l32e    a6,  a11, -40
    l32e    a7,  a11, -36
    l32e    a8,  a11, -32
    l32e    a9,  a11, -28
    l32e    a10, a11, -24
    l32e    a11, a11, -20
    rfwu

/* ------------------------------------------------------------------------ *
 * Exception vectors.
 *
 * Vector offsets confirmed against the real Sesame S2 ELF's .iram0.vectors
 * symbol table (VECBASE = 0x40024000):
 *   0x180 _Level2Vector   0x1C0 _Level3Vector  0x200 _Level4Vector
 *   0x240 _Level5Vector   0x280 _DebugExceptionVector
 *   0x2C0 _NMIExceptionVector  0x300 _KernelExceptionVector
 *   0x340 _UserExceptionVector 0x3C0 _DoubleExceptionVector
 *
 * The user/kernel handler is a *skip-and-continue* handler: it records
 * EXCCAUSE, EXCVADDR and EPC1 into the fault mailbox at 0x3FFD0100, bumps a
 * fault counter, advances EPC1 past the 3-byte faulting instruction, and
 * returns.  That is what lets a single run enumerate every special register
 * the core rejects instead of dying on the first one.
 * ------------------------------------------------------------------------ */


    .org    0x300
    .global _KernelExceptionVector
_KernelExceptionVector:
    j       _probe_exc_common

    .org    0x33C
.Lfaultarea_lit2:
    .word   0x3FFD0100

    .org    0x340
    .global _UserExceptionVector
_UserExceptionVector:
_probe_exc_common:
    wsr.excsave1 a0
    l32r    a0, .Lfaultarea_lit2
    s32i    a2, a0, 0               /* [0]  saved a2                        */
    s32i    a3, a0, 4               /* [4]  saved a3                        */
    rsr.exccause a2
    s32i    a2, a0, 8               /* [8]  last EXCCAUSE                   */
    rsr.epc1 a3
    s32i    a3, a0, 12              /* [12] last EPC1                       */
    l32i    a2, a0, 16
    addi    a2, a2, 1
    s32i    a2, a0, 16              /* [16] fault count                     */
    rsr.excvaddr a2
    s32i    a2, a0, 20              /* [20] last EXCVADDR                   */
    addi    a3, a3, 3               /* skip the faulting 3-byte instruction */
    wsr.epc1 a3
    l32i    a2, a0, 0
    l32i    a3, a0, 4
    rsr.excsave1 a0
    rfe

    .org    0x3C0
    .global _DoubleExceptionVector
_DoubleExceptionVector:
    j       _DoubleExceptionVector

    .org    0x400
