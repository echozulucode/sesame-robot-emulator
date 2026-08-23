/* Deterministic register-window exercisers for R2 rung 3.
 *
 * GCC only ever emits call8 for ordinary C calls, so C alone can exercise
 * WindowOverflow8 / WindowUnderflow8 and nothing else. These three hand-written
 * chains recurse with call4, call8 and call12 respectively, which is what forces
 * WindowOverflow4/12 and WindowUnderflow4/12 as well - all six handlers in
 * vectors.S, in one probe.
 *
 * ABI note: callN rotates the window by N, so the caller passes the first
 * argument in a(N+2) and reads the result back from the same register.
 *
 * Each chain takes a depth in a2 and returns depth+1 in a2, so a wrong
 * spill/fill shows up as a wrong number rather than as a silent pass.
 */

    .section .text.window_chains, "ax"
    .literal_position

    .align  4
    .global w4_chain
    .type   w4_chain, @function
w4_chain:
    entry   a1, 32
    beqz    a2, 1f
    addi    a6, a2, -1
    call4   w4_chain
    addi    a2, a6, 1
    retw
1:  movi    a2, 0
    retw
    .size   w4_chain, . - w4_chain

    .align  4
    .global w8_chain
    .type   w8_chain, @function
w8_chain:
    entry   a1, 32
    beqz    a2, 1f
    addi    a10, a2, -1
    call8   w8_chain
    addi    a2, a10, 1
    retw
1:  movi    a2, 0
    retw
    .size   w8_chain, . - w8_chain

    .align  4
    .global w12_chain
    .type   w12_chain, @function
w12_chain:
    entry   a1, 48
    beqz    a2, 1f
    addi    a14, a2, -1
    call12  w12_chain
    addi    a2, a14, 1
    retw
1:  movi    a2, 0
    retw
    .size   w12_chain, . - w12_chain
