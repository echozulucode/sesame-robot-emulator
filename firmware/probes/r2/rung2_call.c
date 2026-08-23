/* R2 rung 2 — the windowed-ABI test.
 *
 * Built with the core's real ABI (windowed; ESP32 GCC's default, the flags file
 * for esp32s2-libs 3.3.11 does NOT pass -mabi=call0). One non-inlined direct
 * call (call8 + entry + retw) and one indirect call through a volatile function
 * pointer (callx8), at a nesting depth shallow enough that the register file
 * never overflows — so rung 2 isolates entry/retw/call8/callx8 from the window
 * overflow/underflow exceptions that rung 3 targets.
 */
#include "r2_probe.h"

volatile uint32_t seed_a = 0x00001234u;
volatile uint32_t seed_b = 0x00000056u;

__attribute__((noinline, used))
static uint32_t leaf_add(uint32_t x, uint32_t y)
{
    return x + y * 3u;
}

__attribute__((noinline, used))
uint32_t leaf_mix(uint32_t x, uint32_t y)
{
    return (x << 4) ^ (y + 7u);
}

typedef uint32_t (*mixfn)(uint32_t, uint32_t);
volatile mixfn indirect = leaf_mix;

void probe_main(void)
{
    r2_begin(2);

    uint32_t a = seed_a;
    uint32_t b = seed_b;

    RES[R_V0 + 0] = 0xAAAA0001u;           /* progress: before direct call   */
    uint32_t d = leaf_add(a, b);           /* call8 -> entry -> retw         */
    RES[R_V0 + 1] = d;
    RES[R_V0 + 2] = 0xAAAA0002u;           /* progress: direct call returned */

    mixfn f = indirect;
    uint32_t e = f(a, b);                  /* callx8                         */
    RES[R_V0 + 3] = e;
    RES[R_V0 + 4] = 0xAAAA0003u;           /* progress: indirect returned    */

    RES[R_V0 + 5] = FLT[F_COUNT];
    RES[R_V0 + 6] = FLT[F_EXCCAUSE];

    r2_done();
}
