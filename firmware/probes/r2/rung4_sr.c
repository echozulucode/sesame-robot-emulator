/* R2 rung 4 — memw, the sync instructions, and a full special/user-register
 * sweep restricted to registers the REAL Arduino-ESP32 runtime actually uses
 * (see sr_list.h for the provenance of every entry).
 *
 * Every probe is bracketed by the fault counter written by the skip-and-
 * continue exception handler in vectors.S, so ONE run enumerates every
 * register the core rejects instead of dying on the first one.
 *
 * Result layout, at 0x3FFD0200 (SRT), 4 words per entry:
 *   [0] value read back (or R2_SENTINEL|idx if the rsr never executed)
 *   [1] faults raised by the wsr
 *   [2] faults raised by the rsr
 *   [3] the value written (0 for read-only probes)
 */
#include "r2_probe.h"
#include "sr_list.h"

#define SRT ((volatile uint32_t *)0x3FFD0200u)
#define URT ((volatile uint32_t *)0x3FFD0600u)

#define ENT(idx) (SRT + (idx) * 4u)

#define PROBE_R(idx, name, testval)                                        \
    do {                                                                   \
        volatile uint32_t *e = ENT(idx);                                   \
        uint32_t v = R2_SENTINEL | (idx);                                  \
        uint32_t f0 = FLT[F_COUNT];                                        \
        __asm__ volatile ("rsr." #name " %0" : "+r"(v));                   \
        e[0] = v; e[1] = 0; e[2] = FLT[F_COUNT] - f0; e[3] = 0;            \
    } while (0)

#define PROBE_W(idx, name, testval)                                        \
    do {                                                                   \
        volatile uint32_t *e = ENT(idx);                                   \
        uint32_t w = (testval);                                            \
        uint32_t f0 = FLT[F_COUNT];                                        \
        __asm__ volatile ("wsr." #name " %0" :: "r"(w));                   \
        e[0] = 0; e[1] = FLT[F_COUNT] - f0; e[2] = 0; e[3] = w;            \
    } while (0)

#define PROBE_RW(idx, name, testval)                                       \
    do {                                                                   \
        volatile uint32_t *e = ENT(idx);                                   \
        uint32_t w = (testval);                                            \
        uint32_t v = R2_SENTINEL | (idx);                                  \
        uint32_t f0 = FLT[F_COUNT];                                        \
        __asm__ volatile ("wsr." #name " %0" :: "r"(w));                   \
        uint32_t f1 = FLT[F_COUNT];                                        \
        __asm__ volatile ("rsr." #name " %0" : "+r"(v));                   \
        e[0] = v; e[1] = f1 - f0; e[2] = FLT[F_COUNT] - f1; e[3] = w;      \
    } while (0)

/* read, write the same value back, read again: for registers where writing an
 * arbitrary value would break the probe itself (PS, VECBASE, MEMCTL, ATOMCTL) */
#define PROBE_RWB(idx, name, testval)                                      \
    do {                                                                   \
        volatile uint32_t *e = ENT(idx);                                   \
        uint32_t v = R2_SENTINEL | (idx);                                  \
        uint32_t f0 = FLT[F_COUNT];                                        \
        __asm__ volatile ("rsr." #name " %0" : "+r"(v));                   \
        uint32_t f1 = FLT[F_COUNT];                                        \
        __asm__ volatile ("wsr." #name " %0" :: "r"(v));                   \
        __asm__ volatile ("rsync");                                        \
        e[0] = v; e[1] = FLT[F_COUNT] - f1; e[2] = f1 - f0; e[3] = v;      \
    } while (0)

#define DO_SR(idx, name, mode, testval)  PROBE_##mode(idx, name, testval);

#define PROBE_UR_RW(idx, name, testval)                                    \
    do {                                                                   \
        volatile uint32_t *e = URT + (idx) * 4u;                           \
        uint32_t w = (testval);                                            \
        uint32_t v = R2_SENTINEL | (idx);                                  \
        uint32_t f0 = FLT[F_COUNT];                                        \
        __asm__ volatile ("wur." #name " %0" :: "r"(w));                   \
        uint32_t f1 = FLT[F_COUNT];                                        \
        __asm__ volatile ("rur." #name " %0" : "+r"(v));                   \
        e[0] = v; e[1] = f1 - f0; e[2] = FLT[F_COUNT] - f1; e[3] = w;      \
    } while (0)

#define DO_UR(idx, name, mode, testval)  PROBE_UR_##mode(idx, name, testval);

volatile uint32_t mem_a = 0xC0FFEE01u;
volatile uint32_t mem_b;

void probe_main(void)
{
    uint32_t f0, v;

    r2_begin(4);

    /* ---- memw and friends: 4,157 memw in the real image ---------------- */
    f0 = FLT[F_COUNT];
    __asm__ volatile ("memw");
    mem_b = mem_a;
    __asm__ volatile ("memw");
    RES[R_V0 + 0] = FLT[F_COUNT] - f0;      /* faults from memw             */
    RES[R_V0 + 1] = mem_b;                  /* expect 0xC0FFEE01            */

    f0 = FLT[F_COUNT];
    __asm__ volatile ("isync");
    RES[R_V0 + 2] = FLT[F_COUNT] - f0;
    f0 = FLT[F_COUNT];
    __asm__ volatile ("rsync");
    RES[R_V0 + 3] = FLT[F_COUNT] - f0;
    f0 = FLT[F_COUNT];
    __asm__ volatile ("esync");
    RES[R_V0 + 4] = FLT[F_COUNT] - f0;
    f0 = FLT[F_COUNT];
    __asm__ volatile ("dsync");
    RES[R_V0 + 5] = FLT[F_COUNT] - f0;

    /* ---- rsil: 38 uses. Raise then restore INTLEVEL ------------------- */
    f0 = FLT[F_COUNT];
    v = 0;
    __asm__ volatile ("rsil %0, 3" : "=r"(v));
    RES[R_V0 + 6] = FLT[F_COUNT] - f0;
    RES[R_V0 + 7] = v;                       /* old PS                       */
    f0 = FLT[F_COUNT];
    __asm__ volatile ("rsil %0, 0" : "=r"(v));
    RES[R_V0 + 8] = FLT[F_COUNT] - f0;

    /* ---- the special-register sweep ------------------------------------ */
    RES[R_V0 + 9] = 0xCCCC0001u;
    R2_SR_TABLE(DO_SR)
    RES[R_V0 + 10] = 0xCCCC0002u;

    /* ---- user registers ------------------------------------------------ */
    R2_UR_TABLE(DO_UR)
    RES[R_V0 + 11] = 0xCCCC0003u;

    RES[R_V0 + 12] = FLT[F_COUNT];
    RES[R_V0 + 13] = FLT[F_EXCCAUSE];
    RES[R_V0 + 14] = FLT[F_EPC1];

    r2_done();
}
