/* R2 rung 5 - memory accesses at real ESP32-S2 addresses, plus a sweep of every
 * remaining instruction class the real Sesame image contains.
 *
 * Self-describing result table at 0x3FFD0700, 4 words per entry:
 *   [0] faults raised by the instruction under test
 *   [1] the value it produced
 *   [2] tag chars 0..3   (big-endian ASCII)
 *   [3] tag chars 4..7
 * so the dump can be decoded with no side table. Every tag is exactly 4 chars.
 *
 * Ordering is deliberate: the instructions that can plausibly wreck the running
 * probe (rotw, rer, movsp) come last, after everything else has already been
 * recorded and after the done-marker has been set.
 */
#include "r2_probe.h"

#define INS ((volatile uint32_t *)0x3FFD0700u)

static uint32_t ins_idx;

#define T(t0, t1, stmt)                                                    \
    do {                                                                   \
        volatile uint32_t *e = INS + ins_idx * 4u; ins_idx++;              \
        uint32_t f0 = FLT[F_COUNT];                                        \
        out = 0;                                                           \
        stmt;                                                              \
        e[0] = FLT[F_COUNT] - f0;                                          \
        e[1] = out;                                                        \
        e[2] = (uint32_t)(t0);                                             \
        e[3] = (uint32_t)(t1);                                             \
    } while (0)

/* ESP32-S2 address map. Sourced from Espressif's own generated linker scripts
 * shipped with esp32s2-libs 3.3.11:
 *   ld/memory.ld                iram0_0_seg, dram0_0_seg, rtc_iram_seg,
 *                               rtc_slow_seg, rtc_data_seg
 *   ld/esp32s2.peripherals.ld   UART0 = 0x3f400000
 */
#define A_DRAM      0x3FFC0000u   /* dram0_0_seg, well past .bss and results  */
#define A_IRAM_DATA 0x4004C000u   /* iram0_0_seg, past this probe own .text   */
#define A_RTC_DATA  0x3FF9E100u   /* rtc_data_seg: RTC fast RAM, data view    */
#define A_RTC_IRAM  0x40070100u   /* rtc_iram_seg: RTC fast RAM, instr view   */
#define A_RTC_SLOW  0x50000200u   /* rtc_slow_seg                             */

static void mem_probe(uint32_t addr, uint32_t t0, uint32_t t1)
{
    volatile uint32_t *e = INS + ins_idx * 4u; ins_idx++;
    volatile uint32_t *p = (volatile uint32_t *)addr;
    uint32_t f0 = FLT[F_COUNT];
    *p = 0xA5A50000u | (addr & 0xFFFFu);
    uint32_t v = *p;
    e[0] = FLT[F_COUNT] - f0;
    e[1] = v;
    e[2] = t0;
    e[3] = t1;
}

volatile uint32_t scratch32;
volatile unsigned short scratch16;
volatile unsigned char  scratch8[8];

void probe_main(void)
{
    uint32_t out;
    uint32_t x = 0x0001F00Du;
    uint32_t y = 0x00000007u;

    r2_begin(5);
    ins_idx = 0;

    /* ---- 1. memory at real ESP32-S2 addresses -------------------------- */
    mem_probe(A_DRAM,      'dram', 'mem_');
    mem_probe(A_IRAM_DATA, 'iram', 'data');
    mem_probe(A_RTC_DATA,  'rtcd', 'ata_');
    mem_probe(A_RTC_IRAM,  'rtci', 'ram_');
    mem_probe(A_RTC_SLOW,  'rtcs', 'low_');

    /* ---- 2. sub-word and signed loads ---------------------------------- */
    T('s16i', 'l16u', { scratch16 = 0xBEEFu; out = scratch16; });
    T('s8i_', 'l8ui', { scratch8[0] = 0xF3u; out = scratch8[0]; });
    T('l16s', 'i___', { volatile short *q = (volatile short *)&scratch16;
                        *q = (short)-2; out = (uint32_t)(int32_t)*q; });
    /* deliberately unaligned 16-bit load: expected to fault on a core without
       the unaligned-access option; the fault count is the answer either way */
    T('unal', 'ig16', { volatile unsigned short *q =
                            (volatile unsigned short *)((uintptr_t)&scratch32 + 1u);
                        out = *q; });

    /* ---- 3. acquire / release ------------------------------------------ */
    T('l32a', 'i___', { uint32_t r; volatile uint32_t *p = &scratch32;
                        *p = 0x11223344u;
                        __asm__ volatile ("l32ai %0, %1, 0" : "=r"(r) : "r"(p));
                        out = r; });
    T('s32r', 'i___', { uint32_t w = 0x55667788u; volatile uint32_t *p = &scratch32;
                        __asm__ volatile ("s32ri %0, %1, 0" :: "r"(w), "r"(p));
                        out = *p; });
    /* NOT PROBED: s32c1i / SCOMPARE1. xtensa-esp32s2-elf-as 14.2.0 rejects both
     * as "unknown opcode or format name" - the ESP32-S2 core configuration has
     * no conditional-store option, so nothing compiled for the S2 emits it. */

    /* ---- 4. arithmetic / logic the compiler emits ------------------------ */
    T('nsau', '____', { __asm__ volatile ("nsau %0, %1" : "=r"(out) : "r"(x)); });
    T('nsa_', '____', { __asm__ volatile ("nsa %0, %1"  : "=r"(out) : "r"(x)); });
    T('clam', 'ps__', { __asm__ volatile ("clamps %0, %1, 7" : "=r"(out) : "r"(x)); });
    T('salt', '____', { __asm__ volatile ("salt %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('salt', 'u___', { __asm__ volatile ("saltu %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('min_', '____', { __asm__ volatile ("min %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('max_', '____', { __asm__ volatile ("max %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('minu', '____', { __asm__ volatile ("minu %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('maxu', '____', { __asm__ volatile ("maxu %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('sext', '____', { __asm__ volatile ("sext %0, %1, 7" : "=r"(out) : "r"(x)); });
    T('abs_', '____', { __asm__ volatile ("abs %0, %1" : "=r"(out) : "r"(x)); });
    T('neg_', '____', { __asm__ volatile ("neg %0, %1" : "=r"(out) : "r"(x)); });
    T('move', 'qz__', { uint32_t z = 0; out = 0xDEAD0000u;
                        __asm__ volatile ("moveqz %0, %1, %2" : "+r"(out) : "r"(x), "r"(z)); });
    T('movn', 'ez__', { out = 0xDEAD0000u;
                        __asm__ volatile ("movnez %0, %1, %2" : "+r"(out) : "r"(x), "r"(y)); });
    T('movl', 'tz__', { uint32_t z = 0xFFFFFFFFu; out = 0xDEAD0000u;
                        __asm__ volatile ("movltz %0, %1, %2" : "+r"(out) : "r"(x), "r"(z)); });
    T('movg', 'ez__', { out = 0xDEAD0000u;
                        __asm__ volatile ("movgez %0, %1, %2" : "+r"(out) : "r"(x), "r"(y)); });
    T('addx', '4___', { __asm__ volatile ("addx4 %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('subx', '8___', { __asm__ volatile ("subx8 %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });

    /* ---- 5. shifts through SAR ------------------------------------------ */
    T('ssai', 'src_', { __asm__ volatile ("ssai 8\n\tsrc %0, %1, %2"
                                          : "=r"(out) : "r"(x), "r"(y)); });
    T('ssa8', 'lsrc', { __asm__ volatile ("ssa8l %1\n\tsrc %0, %1, %2"
                                          : "=r"(out) : "r"(y), "r"(x)); });
    T('ssa8', 'bsrc', { __asm__ volatile ("ssa8b %1\n\tsrc %0, %1, %2"
                                          : "=r"(out) : "r"(y), "r"(x)); });
    T('ssl_', 'sll_', { __asm__ volatile ("ssl %1\n\tsll %0, %2"
                                          : "=r"(out) : "r"(y), "r"(x)); });
    T('ssr_', 'srl_', { __asm__ volatile ("ssr %1\n\tsrl %0, %2"
                                          : "=r"(out) : "r"(y), "r"(x)); });

    /* ---- 6. multiply / divide options ----------------------------------- */
    T('mull', '____', { __asm__ volatile ("mull %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('mul1', '6u__', { __asm__ volatile ("mul16u %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('mul1', '6s__', { __asm__ volatile ("mul16s %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('mulu', 'h___', { __asm__ volatile ("muluh %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('muls', 'h___', { __asm__ volatile ("mulsh %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('quou', '____', { __asm__ volatile ("quou %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('quos', '____', { __asm__ volatile ("quos %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('remu', '____', { __asm__ volatile ("remu %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });
    T('rems', '____', { __asm__ volatile ("rems %0, %1, %2" : "=r"(out) : "r"(x), "r"(y)); });

    /* ---- 7. xsr form ----------------------------------------------------- */
    T('xsr_', 'inte', { out = 0; __asm__ volatile ("xsr.intenable %0" : "+r"(out)); });

    /* ---- 8. cache control: NOT PROBED, AND NOT NEEDED.
     * xtensa-esp32s2-elf-as 14.2.0 rejects dhwb, dhwbi, dhi, ihi, ipf and dpfr
     * as unknown opcodes: the ESP32-S2 Xtensa core is configured with no data
     * or instruction cache inside the core (the chip's cache sits outside it
     * and is driven over MMIO). Consistent with the real Sesame S2 image, which
     * contains zero Xtensa cache instructions among 135,118 instructions.
     * So "does Renode implement Xtensa cache control" is a non-question here. */

    /* ---- 9. read-only MMU / TLB probes. The real image contains
     * 5 ritlb0, 5 witlb, 4 pitlb, 3 pdtlb, 2 ritlb1, 1 rdtlb0, 2 wdtlb,
     * 1 idtlb - IDF's region-protection setup. Only the reads are probed;
     * a bad witlb/wdtlb would remap the probe out from under itself.        */
    T('pitl', 'b___', { uint32_t p = 0x40024000u;
                        __asm__ volatile ("pitlb %0, %1" : "=r"(out) : "r"(p)); });
    T('ritl', 'b0__', { uint32_t p = 0x00000004u;
                        __asm__ volatile ("ritlb0 %0, %1" : "=r"(out) : "r"(p)); });
    T('ritl', 'b1__', { uint32_t p = 0x00000004u;
                        __asm__ volatile ("ritlb1 %0, %1" : "=r"(out) : "r"(p)); });
    T('pdtl', 'b___', { uint32_t p = 0x3FFC0000u;
                        __asm__ volatile ("pdtlb %0, %1" : "=r"(out) : "r"(p)); });
    T('rdtl', 'b0__', { uint32_t p = 0x00000004u;
                        __asm__ volatile ("rdtlb0 %0, %1" : "=r"(out) : "r"(p)); });

    /* ---- 10. ESP32-S2 dedicated-GPIO TIE instructions -------------------- */
    T('clr_', 'bgpo', { __asm__ volatile ("clr_bit_gpio_out 1"); out = 1; });
    T('set_', 'bgpo', { __asm__ volatile ("set_bit_gpio_out 1"); out = 1; });
    T('wrmk', 'gpo_', { __asm__ volatile ("wr_mask_gpio_out %0, %1" :: "r"(x), "r"(y));
                        out = 1; });

    RES[R_V0 + 0] = ins_idx;
    RES[R_V0 + 1] = FLT[F_COUNT];
    RES[R_V0 + 2] = FLT[F_EXCCAUSE];
    RES[R_V0 + 3] = FLT[F_EPC1];

    /* Everything above is now recorded. The done marker goes here, BEFORE the
     * instructions that can plausibly destroy the running context. */
    r2_done();

    /* ---- 11. destructive / context-mangling instructions ----------------- */
    T('rotw', 'pm1_', { __asm__ volatile ("rotw 1\n\trotw -1"); out = 1; });
#ifdef R5_PROBE_RER
    /* rer is DEFAULT-OFF because it does not raise a recoverable exception in
     * Renode 1.16.1: tlib issues
     *   [ERROR] cpu: CPU abort [PC=0x...]: reading from external register not
     *   yet supported.
     * which wedges the emulator (RunFor never returns). Build a separate ELF
     * with -DR5_PROBE_RER to reproduce it deliberately. */
    T('rer_', '____', { uint32_t p = 0u;
                        __asm__ volatile ("rer %0, %1" : "=r"(out) : "r"(p)); });
#endif
    T('movs', 'p___', { __asm__ volatile ("movsp %0, %1" : "=r"(out) : "r"(x)); });

    RES[R_V0 + 4] = ins_idx;
    RES[R_V0 + 5] = FLT[F_COUNT];
    RES[R_V0 + 6] = 0xEEEE0001u;
}
