# Numbers and addresses

Every number must carry a hex marker: `0x4C` or `4Ch`. Bare digits (`76`, `21`) are rejected, because decimal vs hex
cannot be guessed. Inside `SEGMENT:OFFSET` (`B800:0160`) and far calls (`0016:0020`) both parts are hex as written.

`module`, `trace`, `next_work`, `add_implementation` and `annotate` accept a node name or any address as the code and
listings print it, mnemonic included: far calls (`lcall 0x41, 0x25`, `lcall 0x3a0, 0x112`,
`call word 0x41:word 0x25`), `seg:off` (`3a0:0112`), near calls and listing offsets (`call 0x34f`, `1a2c`), or a
call/branch site inside a function (resolves to that function).

How each form offsets addresses is learned from `callgraph.json` itself: every edge pairs an operand as written with
its target node, and a (form, source file, base) frame is trusted once 3+ distinct targets agree on a
paragraph-aligned base; the graph may also declare frames. Overlay modules share one address range, so a bare overlay
address can be ambiguous; the error lists the candidates. Unmarked addresses without a segment must be 4 hex digits,
the width listing lines print.

Node ids name the file the code is in, then the address its listing shows: `MAIN_EXE:1a2c` is load-image offset 1a2c
of MAIN.EXE; `MAIN_OVR-0020:0100` is offset 0100 in the MAIN.OVR overlay whose stub segment is 0020, the segment other
code writes in `lcall 0x20, <stub entry>`.
