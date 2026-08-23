/* R2 rung 1 — baseline: real compiler output, straight-line arithmetic, no calls.
 *
 * Built with -mabi=call0 so that NOTHING in this rung touches the windowed
 * ABI. That is the whole point: rung 1 and rung 2 differ only in the ABI, so
 * any difference between them is attributable to register windows and nothing
 * else.
 *
 * Exercises: l32r literal loads, s32i/l32i, add/sub/xor/and/or, slli/srli/srai,
 * mull, quou/remu (32-bit divide option), extui, sext, nsau, min/max.
 */
#include "r2_probe.h"

/* volatile seeds in .data, so -O2 cannot constant-fold the whole rung away */
volatile uint32_t seed_a = 0x12345678u;
volatile uint32_t seed_b = 0x000000ABu;
volatile int32_t  seed_c = -1234567;

void probe_main(void)
{
    r2_begin(1);

    uint32_t a = seed_a;
    uint32_t b = seed_b;
    int32_t  c = seed_c;

    RES[R_V0 + 0] = a + b;                 /* add          */
    RES[R_V0 + 1] = a - b;                 /* sub          */
    RES[R_V0 + 2] = a ^ b;                 /* xor          */
    RES[R_V0 + 3] = a & 0xFF00FFu;         /* and          */
    RES[R_V0 + 4] = a << 5;                /* slli         */
    RES[R_V0 + 5] = a >> 7;                /* srli         */
    RES[R_V0 + 6] = (uint32_t)(c >> 3);    /* srai         */
    RES[R_V0 + 7] = a * b;                 /* mull         */
    RES[R_V0 + 8] = a / b;                 /* quou         */
    RES[R_V0 + 9] = a % b;                 /* remu         */
    RES[R_V0 + 10] = (a >> 8) & 0xFFFu;    /* extui        */
    RES[R_V0 + 11] = (uint32_t)(int32_t)(int8_t)(a & 0xFFu);  /* sext */
    RES[R_V0 + 12] = (a < b) ? a : b;      /* minu/moveqz  */
    RES[R_V0 + 13] = (uint32_t)((int64_t)(int32_t)a * (int32_t)b >> 32); /* mulsh */

    r2_done();
}
