/* R2 rung 3 - register-window overflow / underflow exceptions.
 *
 * The most important rung in the ladder. Xtensa's windowed ABI only stays cheap
 * while the 64-entry physical register file has room; past that the hardware
 * raises WindowOverflow{4,8,12} on the way down and WindowUnderflow{4,8,12} on
 * the way back up, and the handlers in vectors.S spill and fill through a1. If
 * tlib's esp32s2 configuration does not implement those exceptions, or s32e /
 * l32e / rfwo / rfwu, then no compiled ESP-IDF code survives past roughly seven
 * call levels and the whole full-emulation path is dead.
 *
 * Three independent measurements:
 *   1. C recursion through a volatile function pointer. The indirect call
 *      defeats GCC's accumulator/tail transform - without it -Os rewrites the
 *      recursion into a loop and the rung silently tests nothing. It compiles to
 *      callx8, i.e. exactly what the real firmware does 4,464 times.
 *   2. The three hand-written chains in window_chains.S, which recurse with
 *      call4 / call8 / call12 and therefore hit all six window handlers.
 *   3. A per-level progress trail, so a run that dies mid-spill reports the
 *      exact depth it reached.
 */
#include "r2_probe.h"

extern unsigned w4_chain(unsigned n);
extern unsigned w8_chain(unsigned n);
extern unsigned w12_chain(unsigned n);

volatile uint32_t seed_depth = 48;

typedef uint32_t (*recfn)(uint32_t, uint32_t);
static uint32_t recurse(uint32_t n, uint32_t acc);
static volatile recfn rec = recurse;

__attribute__((noinline, used))
static uint32_t recurse(uint32_t n, uint32_t acc)
{
    uint32_t local0 = n * 3u + 1u;
    uint32_t local1 = n ^ 0x5Au;

    if (n == 0u) {
        return acc;
    }

    /* how deep did we actually get before dying? */
    RES[R_V0 + 0] = n;

    uint32_t deeper = rec(n - 1u, acc + n);

    /* local0/local1 are live across the call, so they must survive a spill and
     * a fill; a broken underflow shows up as a wrong checksum, not a crash. */
    return deeper ^ (local0 << 8) ^ (local1 << 16);
}

void probe_main(void)
{
    r2_begin(3);

    uint32_t depth = seed_depth;

    RES[R_V0 + 1] = 0xBBBB0001u;
    RES[R_V0 + 2] = recurse(depth, 0u);       /* callx8 chain, depth 48 */
    RES[R_V0 + 3] = 0xBBBB0002u;

    RES[R_V0 + 4] = w4_chain(40u);            /* expect 40 */
    RES[R_V0 + 5] = 0xBBBB0003u;
    RES[R_V0 + 6] = w8_chain(40u);            /* expect 40 */
    RES[R_V0 + 7] = 0xBBBB0004u;
    RES[R_V0 + 8] = w12_chain(40u);           /* expect 40 */
    RES[R_V0 + 9] = 0xBBBB0005u;

    RES[R_V0 + 10] = FLT[F_COUNT];
    RES[R_V0 + 11] = FLT[F_EXCCAUSE];
    RES[R_V0 + 12] = FLT[F_EPC1];

    r2_done();
}
