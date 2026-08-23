/* R2 Xtensa execution-probe linker script (ESP32-S2 / LX7).
 *
 * Addresses are taken from Espressif's own generated ESP32-S2 linker script
 * shipped with the pinned Arduino core:
 *   tools/arduino-data/data/packages/esp32/tools/esp32s2-libs/3.3.11/ld/memory.ld
 *     iram0_0_seg org = (0x40020000 + 0x2000 + 0x2000) = 0x40024000
 *     dram0_0_seg org = (0x3FFB0000 + 0x2000 + 0x2000) = 0x3FFB4000
 *     both len     = 0x3FFDE000 - 0x3FFB4000 = 0x2A000
 * The real Sesame S2 ELF places .iram0.vectors at exactly 0x40024000, so this
 * probe puts its window-exception vector table at the same address.
 */

ENTRY(_start)

MEMORY
{
  iram (RX)  : ORIGIN = 0x40024000, LENGTH = 0x2A000
  dram (RW)  : ORIGIN = 0x3FFB4000, LENGTH = 0x1C000   /* stops below .results */
}

/* Fixed, hard-coded so the .resc can read results without symbol lookup. */
_results_base = 0x3FFD0000;
_stack_top    = 0x3FFDDFF0;

SECTIONS
{
  /* VECBASE target. Must be 1 KiB aligned; 0x40024000 is 16 KiB aligned. */
  .vectors ORIGIN(iram) :
  {
    _vecbase = ABSOLUTE(.);
    KEEP(*(.WindowVectors.text))
    /* vectors.S ends with .org 0x400, so this section is exactly 1 KiB when
       it is linked in, and empty for the call0 rung that omits it. */
  } > iram

  .text ORIGIN(iram) + 0x400 :
  {
    _text_start = ABSOLUTE(.);
    KEEP(*(.entry.text))
    *(.literal .literal.* .text .text.*)
    . = ALIGN(4);
    *(.rodata .rodata.* .srodata .srodata.*)
    . = ALIGN(4);
    _text_end = ABSOLUTE(.);
  } > iram

  .data : ALIGN(4)
  {
    _data_start = ABSOLUTE(.);
    *(.data .data.* .sdata .sdata.*)
    . = ALIGN(4);
    _data_end = ABSOLUTE(.);
  } > dram

  .bss (NOLOAD) : ALIGN(8)
  {
    _bss_start = ABSOLUTE(.);
    *(.bss .bss.* .sbss .sbss.* COMMON)
    . = ALIGN(8);
    _bss_end = ABSOLUTE(.);
  } > dram

  /* Result mailbox at a fixed absolute address the .resc hard-codes. */
  .results _results_base (NOLOAD) :
  {
    KEEP(*(.results))
    . = ALIGN(4);
  }

  /DISCARD/ : { *(.comment) *(.note.*) *(.xt.*) *(.xtensa.*) }
}
