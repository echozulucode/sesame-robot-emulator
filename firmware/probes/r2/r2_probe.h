/* Shared mailbox layout for the R2 Xtensa execution-probe ladder.
 *
 * Two fixed DRAM addresses, hard-coded here and in probe.ld and in the .resc
 * scripts, so a Renode run can read the outcome with plain
 * `sysbus ReadDoubleWord` and no symbol lookup.
 *
 *   0x3FFD0000  RES[0..63]   result mailbox
 *   0x3FFD0100  FLT[0..7]    exception mailbox, written by _UserExceptionVector
 */
#ifndef R2_PROBE_H
#define R2_PROBE_H

#include <stdint.h>

#define R2_RESULTS_BASE  0x3FFD0000u
#define R2_FAULTS_BASE   0x3FFD0100u

#define RES  ((volatile uint32_t *)R2_RESULTS_BASE)
#define FLT  ((volatile uint32_t *)R2_FAULTS_BASE)

/* RES word map (words 0..4 are written by start.S, before any C runs) */
#define R_START_ENTERED   0   /* 1: first instruction executed, l32r+s32i work */
#define R_WINDOW_INIT     1   /* 2: WindowBase/WindowStart written             */
#define R_PS_SET          2   /* 3: PS written                                 */
#define R_PRE_CALL        3   /* 4: stack set, .bss zeroed, about to call C    */
#define R_POST_CALL       4   /* 5: C returned                                 */
#define R_RUNG            8   /* rung id, first thing C writes                 */
#define R_V0              9   /* rung-specific values                          */
#define R_DONE            31  /* 0xD09EF00D                                    */

/* FLT word map */
#define F_SAVED_A2   0
#define F_SAVED_A3   1
#define F_EXCCAUSE   2
#define F_EPC1       3
#define F_COUNT      4
#define F_EXCVADDR   5

#define R2_DONE_MAGIC   0xD09EF00Du
#define R2_SENTINEL     0xBADBAD00u   /* | index; means "never executed"      */

static inline void r2_begin(uint32_t rung)
{
    for (int i = 0; i < 8; ++i) FLT[i] = 0;
    for (int i = R_RUNG; i < 32; ++i) RES[i] = 0;
    RES[R_RUNG] = rung;
}

static inline void r2_done(void) { RES[R_DONE] = R2_DONE_MAGIC; }

#endif /* R2_PROBE_H */
