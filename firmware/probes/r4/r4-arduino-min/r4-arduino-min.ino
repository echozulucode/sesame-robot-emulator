/*
 * R4 / Experiment 4 - the smallest possible Arduino-ESP32 sketch.
 *
 * Question it exists to answer: does the Arduino-ESP32 3.3.11 runtime, built by
 * F3's real toolchain for the s2mini profile, reach USER setup() when loaded
 * directly into Renode 1.16.1 on emulator/renode/platforms/esp32s2-sesame.repl?
 *
 * Two independent markers are emitted, deliberately:
 *
 *  1. A RAW UART0 FIFO write (r4_raw_mark). This bypasses HardwareSerial, USB-CDC,
 *     the clock tree and the interrupt matrix entirely - it is three volatile
 *     stores to 0x3F400000, which R3 proved works on this platform. If ANY of
 *     these appear on tcp/3456, that rung was reached, whatever Serial is doing.
 *     Offsets from esp32s2-libs/3.3.11/include/soc/esp32s2/register/soc/uart_reg.h
 *     (UART_FIFO_REG = base + 0x00) and esp32s2.peripherals.ld:6 (UART0 base).
 *
 *  2. Serial.println() - the ordinary Arduino path. On lolin_s2_mini with
 *     CDCOnBoot=default this is USB-CDC, NOT UART0, so its ABSENCE from the
 *     socket proves nothing about Serial; it is here because the task asks for a
 *     sketch whose setup() "prints a marker", and because reaching the call at
 *     all is the interesting event.
 *
 * The raw markers are ordered so the last one seen tells you exactly how far the
 * runtime got:
 *   A = first instruction of user setup()      (initArduino + app_main + loopTask done)
 *   B = after Serial.begin(115200) returned
 *   C = after Serial.println() returned
 *   L = first loop() iteration
 */
#include <Arduino.h>

static inline void r4_raw_mark(char c) {
  volatile uint32_t *fifo = (volatile uint32_t *)0x3F400000u; /* UART0 UART_FIFO_REG */
  *fifo = (uint32_t)'@';
  *fifo = (uint32_t)'R';
  *fifo = (uint32_t)'4';
  *fifo = (uint32_t)c;
  *fifo = (uint32_t)'\n';
}

void setup() {
  r4_raw_mark('A');
  Serial.begin(115200);
  r4_raw_mark('B');
  Serial.println("R4-ARDUINO-SETUP-MARKER");
  r4_raw_mark('C');
}

void loop() {
  static bool first = true;
  if (first) {
    first = false;
    r4_raw_mark('L');
  }
}
