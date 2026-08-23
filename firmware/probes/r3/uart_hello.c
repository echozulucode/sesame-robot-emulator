/* R3 - freestanding C that drives ESP32-S2 UART0 by MMIO.
 *
 * No ESP-IDF, no Arduino, no libc. Just the compiler F3 installed, the register
 * offsets Renode's ESP32_UART model implements, and the UART0 base address from
 * Espressif's own generated linker script:
 *
 *   tools/arduino-data/data/packages/esp32/tools/esp32s2-libs/3.3.11/
 *       ld/esp32s2.peripherals.ld:6   PROVIDE ( UART0 = 0x3f400000 );
 *
 * The lines it emits are real Sesame telemetry: they are fed byte-for-byte
 * through packages/sesame-protocol's streaming parser by
 * emulator/renode/tests/r3-uart-capture.mjs, which is the R7 handshake proved
 * a wave early.
 */
#include "r2_probe.h"

/* --- ESP32-S2 UART0 ------------------------------------------------------ *
 * Base from esp32s2.peripherals.ld (above). Register offsets from the ESP32-S2
 * TRM chapter "UART Controller", cross-checked against the offsets Renode's
 * UART.ESP32_UART model actually decodes (R1 section 5.3 found 11 of 30
 * implemented: 0x00 0x04 0x0C 0x10 0x14 0x18 0x1C 0x20 0x24 0x30 0x78).
 */
#define UART0_BASE      0x3F400000u
#define UART_FIFO       (*(volatile uint32_t *)(UART0_BASE + 0x00u))
#define UART_INT_RAW    (*(volatile uint32_t *)(UART0_BASE + 0x04u))
#define UART_INT_ENA    (*(volatile uint32_t *)(UART0_BASE + 0x0Cu))
#define UART_INT_CLR    (*(volatile uint32_t *)(UART0_BASE + 0x10u))
#define UART_STATUS     (*(volatile uint32_t *)(UART0_BASE + 0x1Cu))

/* UART_STATUS_REG: TXFIFO_CNT is bits [25:16] on the S2. */
#define TXFIFO_CNT(s)   (((s) >> 16) & 0x3FFu)
#define TXFIFO_LIMIT    120u

static uint32_t poll_spins;

static void uart_putc(char c)
{
    /* Bounded poll: a model that never drains the FIFO must not hang the probe. */
    for (uint32_t i = 0; i < 1000u; ++i) {
        if (TXFIFO_CNT(UART_STATUS) < TXFIFO_LIMIT) break;
        poll_spins++;
    }
    UART_FIFO = (uint32_t)(unsigned char)c;
}

static void uart_puts(const char *s)
{
    while (*s) uart_putc(*s++);
}

/* Telemetry lines. Kept as one array so the exact bytes are visible in the
 * ELF's .rodata and can be diffed against what the host socket received. */
static const char *const lines[] = {
    "r3-uart-probe: esp32s2 uart0 mmio, no idf\r\n",
    "@SESAME hello 1 sesame-lab-r3\n",
    "@SESAME servo R4 72\n",
    "@SESAME servo L1 15\n",
    "@SESAME face wave 0\n",
    "@SESAME log firmware renode esp32s2 uart0 up\n",
    "r3-uart-probe: done\r\n",
};

void probe_main(void)
{
    r2_begin(3103);   /* rung id: R3, probe 1 */

    /* Disable and clear UART interrupts: R1 section 8.2 found that Renode's
     * ESP32_UART enumerates UART_INT_ST (0x08) but never implements it, so
     * anything interrupt-driven is broken by construction. This probe is
     * deliberately polled/FIFO-only. */
    UART_INT_ENA = 0u;
    UART_INT_CLR = 0xFFFFFFFFu;
    RES[R_V0 + 0] = FLT[F_COUNT];          /* faults from the two MMIO writes */

    uint32_t st = UART_STATUS;
    RES[R_V0 + 1] = st;                    /* UART_STATUS as the model reports */
    RES[R_V0 + 2] = FLT[F_COUNT];

    for (unsigned i = 0; i < sizeof(lines) / sizeof(lines[0]); ++i) {
        uart_puts(lines[i]);
        RES[R_V0 + 3 + i] = 0xF1F00000u | i;   /* per-line progress marker */
    }

    RES[R_V0 + 12] = poll_spins;
    RES[R_V0 + 13] = FLT[F_COUNT];
    RES[R_V0 + 14] = FLT[F_EXCCAUSE];
    RES[R_V0 + 15] = FLT[F_EPC1];

    r2_done();
}
