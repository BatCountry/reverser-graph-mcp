// Authored from the IBM EGA Technical Reference, the bundled hardware notes, the Tandy 1000 SX
// Technical Reference and "Sounding Off on the 1000" notes. Entries marked [std] come from
// widely documented PC hardware conventions that the bundled sources do not cover.

export interface Field {
  hi: number;
  lo: number;
  name: string;
  /** meaning per value; omitted values print as the raw number */
  values?: Readonly<Record<number, string>>;
  /** for 1-bit flags: meaning when set / clear */
  set?: string;
  clear?: string;
}

export interface RegDoc {
  name: string;
  access: "read" | "write" | "read/write";
  summary: string;
  fields?: readonly Field[];
}

const flag = (bit: number, name: string, set: string, clear?: string): Field => ({ hi: bit, lo: bit, name, set, ...(clear ? { clear } : {}) });
const bits = (hi: number, lo: number, name: string, values?: Record<number, string>): Field => ({ hi, lo, name, ...(values ? { values } : {}) });

/** Describe `value` against the fields of a register. */
export function decodeFields(fields: readonly Field[] | undefined, value: number): string[] {
  if (!fields) return [];
  const out: string[] = [];
  for (const f of [...fields].sort((a, b) => b.hi - a.hi)) {
    const v = (value >> f.lo) & ((1 << (f.hi - f.lo + 1)) - 1);
    // a clear flag with no stated meaning is just "feature off": not worth a line
    if (f.hi === f.lo && v === 0 && f.clear === undefined) continue;
    const range = f.hi === f.lo ? `bit ${f.hi}` : `bits ${f.hi}-${f.lo}`;
    const meaning = f.hi === f.lo ? (v ? f.set : f.clear) : (f.values?.[v] ?? `value ${v}`);
    out.push(`${range} ${f.name} = ${v}: ${meaning}`);
  }
  return out;
}

/** Field names only ("bits 3-0 plane write enable"), highest bit first. */
export function fieldLayout(fields: readonly Field[] | undefined): string[] {
  return [...(fields ?? [])].sort((a, b) => b.hi - a.hi).map((f) => `${f.hi === f.lo ? `bit ${f.hi}` : `bits ${f.hi}-${f.lo}`} ${f.name}`);
}

// ---------------------------------------------------------------- indexed register files

export interface IndexedFile {
  id: string;
  title: string;
  /** address/index port(s) and data port(s) */
  addressPorts: readonly number[];
  dataPorts: readonly number[];
  summary: string;
  registers: Readonly<Record<number, RegDoc>>;
}

const planes = (n: string) => `plane ${n}`;

export const SEQUENCER: IndexedFile = {
  id: "vga-sequencer",
  title: "EGA/VGA Sequencer (index port 3C4h, data port 3C5h)",
  addressPorts: [0x3c4],
  dataPorts: [0x3c5],
  summary:
    "Controls memory timing and which bit planes the CPU writes. Write the register index to 3C4h, then the value to 3C5h (or both at once with `OUT DX,AX` to 3C4h: AL=index, AH=value). The one game code uses constantly is Map Mask (index 02h).",
  registers: {
    0x00: { name: "Reset", access: "write", summary: "Starts/stops the sequencer. Both bits must be 1 for it to run; clear bit 1 before changing Clocking Mode if memory contents must survive.", fields: [flag(0, "asynchronous reset", "run", "asynchronous clear and halt"), flag(1, "synchronous reset", "run", "synchronous clear and halt")] },
    0x01: { name: "Clocking Mode", access: "write", summary: "Character width, memory bandwidth and dot clock. 320-pixel-wide modes (0,1,4,5,0Dh,13h) set the dot-clock divide.", fields: [flag(0, "8/9 dot clocks", "8 dots per character", "9 dots per character (mono text mode 07h)"), flag(1, "bandwidth", "CRT uses 2 of 5 memory cycles (medium resolution)", "CRT uses 4 of 5 memory cycles"), flag(2, "shift load", "serializers load every other character clock"), flag(3, "dot clock", "master clock divided by 2 (320-wide modes)", "normal dot clock"), flag(5, "screen off [std, VGA]", "screen blanked, CPU gets full memory bandwidth", "screen on")] },
    0x02: { name: "Map Mask", access: "write", summary: "Which of the 4 bit planes a CPU write reaches. 0Fh writes all planes at once; a single bit targets one plane. Also used to clear/fill all planes quickly in planar modes (see dosref://memory/ega-vga-graphics).", fields: [bits(3, 0, "plane write enable (bit n = plane n)", Object.fromEntries(Array.from({ length: 16 }, (_, v) => [v, v === 0 ? "no plane writable" : `writes reach ${[0, 1, 2, 3].filter((p) => v & (1 << p)).map((p) => planes(String(p))).join(", ")}`])))] },
    0x03: { name: "Character Map Select", access: "write", summary: "Which font map (in plane 2) generates text characters; attribute bit 3 switches between map A and B when they differ.", fields: [bits(1, 0, "character map B (attribute bit 3 = 0)"), bits(3, 2, "character map A (attribute bit 3 = 1)")] },
    0x04: { name: "Memory Mode", access: "write", summary: "How CPU addresses map to planes. EGA: bit 2 clear = odd/even (text/CGA modes), set = sequential. VGA adds Chain-4 (bit 3): CPU address bits 0-1 pick the plane, giving mode 13h's linear 256-colour layout; clearing it gives unchained 'Mode X'.", fields: [flag(0, "alpha", "alphanumeric mode (enables character map select)", "graphics mode"), flag(1, "extended memory", "memory beyond 64 KB installed/accessible"), flag(2, "odd/even", "sequential plane access (odd/even addressing OFF)", "even addresses -> planes 0,2; odd -> planes 1,3"), flag(3, "chain-4 [std, VGA]", "chain-4: linear 256-colour addressing", "not chained")] },
  },
};

export const GRAPHICS_CONTROLLER: IndexedFile = {
  id: "vga-graphics-controller",
  title: "EGA/VGA Graphics Controller (index port 3CEh, data port 3CFh)",
  addressPorts: [0x3ce],
  dataPorts: [0x3cf],
  summary:
    "Sits between the CPU and the four planes: set/reset, write modes, rotate/logic, read modes, bit mask. Write the index to 3CEh and the value to 3CFh (or `OUT DX,AX` to 3CEh with AL=index, AH=value). Write mode (05h), bit mask (08h) and read map select (04h) are the workhorses of planar sprite/pixel code.",
  registers: {
    0x00: { name: "Set/Reset", access: "write", summary: "Colour bits written to each plane when write mode 0 has Set/Reset enabled for that plane (a pixel colour fill without reading).", fields: [bits(3, 0, "value written to plane n (bit n)")] },
    0x01: { name: "Enable Set/Reset", access: "write", summary: "Per-plane enable for Set/Reset in write mode 0; planes not enabled get the (rotated) CPU data.", fields: [bits(3, 0, "set/reset enabled on plane n (bit n)")] },
    0x02: { name: "Color Compare", access: "write", summary: "4-bit colour compared against all planes when read mode 1 is selected; the read returns 1 bits where the colour matches.", fields: [bits(3, 0, "colour to compare")] },
    0x03: { name: "Data Rotate / Function Select", access: "write", summary: "Rotate the CPU data and choose how it combines with the latched data already in the planes.", fields: [bits(2, 0, "rotate count (right)"), bits(4, 3, "function select", { 0: "data unmodified", 1: "AND with latches", 2: "OR with latches", 3: "XOR with latches" })] },
    0x04: { name: "Read Map Select", access: "write", summary: "Which plane CPU reads return (read mode 0). Ignored in read mode 1. Reading A000:xxxx also loads all four planes into the latches.", fields: [bits(2, 0, "plane read (0-3)")] },
    0x05: { name: "Mode Register", access: "write", summary: "Write mode (0-3), read mode and odd/even/shift-register formats. Planar sprite blitters usually use write mode 0, 1 (latch copy) or 2.", fields: [bits(1, 0, "write mode", { 0: "plane written with rotated CPU data, or Set/Reset where enabled", 1: "planes written from the latches (copy video memory to video memory)", 2: "CPU data bits 0-3 are the colour; bit mask selects pixels", 3: "[VGA] CPU data is the bit mask, Set/Reset is the colour" }), flag(2, "test condition", "outputs high-impedance (test only)"), flag(3, "read mode", "read mode 1: colour compare", "read mode 0: read selected plane"), flag(4, "odd/even", "odd/even addressing (CGA-compatible modes)"), flag(5, "shift register", "even bits on even planes, odd bits on odd planes (CGA 2-bit modes)"), flag(6, "256-colour shift [std, VGA]", "256-colour shift register (mode 13h)")] },
    0x06: { name: "Miscellaneous", access: "write", summary: "Where the framebuffer appears in CPU address space and whether it is alpha or graphics addressing.", fields: [flag(0, "graphics mode", "graphics addressing", "alphanumeric addressing"), flag(1, "chain odd maps to even", "address bit 0 replaced by a higher bit (odd/even chaining)"), bits(3, 2, "memory map", { 0: "A000h, 128 KB", 1: "A000h, 64 KB (EGA/VGA graphics)", 2: "B000h, 32 KB (mono text)", 3: "B800h, 32 KB (colour text)" })] },
    0x07: { name: "Color Don't Care", access: "write", summary: "Selects which planes take part in the read-mode-1 colour compare. VGA documentation: a set bit includes the plane; the scanned EGA manual words it as 'don\'t care' when set, so confirm polarity against the code you are reading.", fields: [bits(3, 0, "per-plane compare mask (bit n = plane n)")] },
    0x08: { name: "Bit Mask", access: "write", summary: "Per-pixel write protect within a byte: a 0 bit leaves that pixel at the latched value (so latches must be loaded by reading the byte first). Used for sub-byte pixel/sprite edges.", fields: [bits(7, 0, "pixel write enable mask (bit set = pixel may change)")] },
  },
};

const CRTC_REGS: Record<number, RegDoc> = {
  0x00: { name: "Horizontal Total", access: "write", summary: "Total character clocks per scanline, minus 5 (VGA) / 2." },
  0x01: { name: "Horizontal Display Enable End", access: "write", summary: "Last displayed character column (columns - 1)." },
  0x02: { name: "Start Horizontal Blanking", access: "write", summary: "Character at which horizontal blanking starts." },
  0x03: { name: "End Horizontal Blanking", access: "write", summary: "End of horizontal blanking (low 5 bits) and display-enable skew." },
  0x04: { name: "Start Horizontal Retrace", access: "write", summary: "Character at which horizontal retrace pulse starts." },
  0x05: { name: "End Horizontal Retrace", access: "write", summary: "End of horizontal retrace (bits 0-4), retrace delay (bits 5-6) and, on EGA, bit 7 = start odd/even." },
  0x06: { name: "Vertical Total", access: "write", summary: "Total scanlines per frame - 2 (low 8 bits; bits 8-9 in Overflow)." },
  0x07: { name: "Overflow", access: "write", summary: "High bits of vertical total/display-end/retrace-start/blank-start/line-compare registers." },
  0x08: { name: "Preset Row Scan", access: "write", summary: "Starting scanline for the first character row, and byte panning (vertical smooth scroll within a character cell)." },
  0x09: { name: "Maximum Scan Line", access: "write", summary: "Scanlines per character row minus 1 (7 = 8-line cells). VGA: bit 7 = double-scan (200-line modes on 400-line timing), bit 6 = line compare bit 9, bit 5 = start vertical blank bit 9. Setting it to 1 or 3 is the 'tweak' used to create Mode X heights." },
  0x0a: { name: "Cursor Start", access: "write", summary: "First scanline of the text cursor (bits 0-4); bit 5 disables the cursor (VGA)." },
  0x0b: { name: "Cursor End", access: "write", summary: "Last scanline of the text cursor; bits 5-6 = cursor skew." },
  0x0c: { name: "Start Address High", access: "read/write", summary: "High byte of the display start address (in words/characters in text; per-plane byte offset in graphics). With 0Dh it scrolls the screen and selects the displayed page: write 0Ch/0Dh during vertical retrace for page flipping." },
  0x0d: { name: "Start Address Low", access: "read/write", summary: "Low byte of the display start address (see 0Ch)." },
  0x0e: { name: "Cursor Location High", access: "read/write", summary: "High byte of the text cursor character offset." },
  0x0f: { name: "Cursor Location Low", access: "read/write", summary: "Low byte of the text cursor character offset (offset = row*columns + col)." },
  0x10: { name: "Vertical Retrace Start", access: "write", summary: "Scanline where vertical retrace starts (reads as light pen high on 6845-compatible adapters)." },
  0x11: { name: "Vertical Retrace End", access: "write", summary: "End of vertical retrace (low 4 bits); bit 4 clears the vertical-retrace interrupt, bit 5 enables it (IRQ 2 on EGA), bit 7 write-protects CRTC registers 0-7." },
  0x12: { name: "Vertical Display Enable End", access: "write", summary: "Last displayed scanline - 1 (low 8 bits of display height)." },
  0x13: { name: "Offset", access: "write", summary: "Logical row width: bytes per row per plane = Offset * 2 in word mode (e.g. 40 -> 80 bytes for 640 pixels). Mode 13h uses doubleword mode (14h bit 6): 40 * 8 = 320. Set it above the visible width for horizontal scrolling/virtual screens." },
  0x14: { name: "Underline Location", access: "write", summary: "Scanline of the text underline; VGA bit 6 = doubleword addressing, bit 5 = count by 4." },
  0x15: { name: "Start Vertical Blanking", access: "write", summary: "Scanline where vertical blanking starts." },
  0x16: { name: "End Vertical Blanking", access: "write", summary: "Scanline where vertical blanking ends." },
  0x17: { name: "Mode Control", access: "write", summary: "Word/byte addressing, CGA/Hercules address-bit compatibility, timing enable. Bit 6 = byte mode vs word mode memory addressing; bit 7 = hardware reset (timing enable).", fields: [flag(0, "CGA compatibility (row scan bit 0 -> address bit 13)", "enabled"), flag(1, "Hercules compatibility (row scan bit 1 -> address bit 14)", "enabled"), flag(5, "address wrap", "wrap at 16K (CGA-like)"), flag(6, "word/byte mode", "byte mode", "word mode"), flag(7, "timing enable", "sync enabled (reset released)", "sync disabled")] },
  0x18: { name: "Line Compare", access: "write", summary: "Scanline at which the display address restarts at 0: the split-screen (status bar) position." },
};

export const CRTC: IndexedFile = {
  id: "vga-crtc",
  title: "6845/EGA/VGA CRT Controller (index 3D4h/3B4h, data 3D5h/3B5h)",
  addressPorts: [0x3b4, 0x3d4],
  dataPorts: [0x3b5, 0x3d5],
  summary:
    "Video timing, text cursor, display start address, row offset and split-screen. 3D4h/3D5h in colour modes, 3B4h/3B5h in mono (EGA/VGA choose via Miscellaneous Output bit 0). Page flipping and hardware scrolling write registers 0Ch/0Dh; Mode X tweaks rewrite the timing registers.",
  registers: CRTC_REGS,
};

export const ATTRIBUTE: IndexedFile = {
  id: "vga-attribute",
  title: "EGA/VGA Attribute Controller (port 3C0h; read 3C1h)",
  addressPorts: [0x3c0],
  dataPorts: [0x3c0, 0x3c1],
  summary:
    "Palette (16 entries mapping pixel/attribute values to colours), blink/intensity, overscan colour, plane enable and horizontal pixel panning. Unusual: 3C0h is BOTH address and data port, alternating on a hidden flip-flop that reading Input Status 1 (3DAh/3BAh) resets to 'address'. Code that touches 3C0h normally does `IN AL,DX` from 3DAh first. Bit 5 of the index byte must be 1 afterwards or the screen goes blank.",
  registers: {
    ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i, { name: `Palette Register ${i.toString(16).toUpperCase()}`, access: "write", summary: "6-bit colour (EGA: rgbRGB, 2 bits per primary; VGA: index into the DAC table) displayed for attribute/pixel value " + i + ". Change during vertical retrace to avoid flicker.", fields: [bits(5, 0, "colour")] } as RegDoc])),
    0x10: { name: "Mode Control", access: "write", summary: "Graphics vs text, mono attributes, line graphics, blink vs bright background.", fields: [flag(0, "graphics/alphanumeric", "graphics mode", "alphanumeric mode"), flag(1, "mono/colour attributes", "mono display attributes", "colour attributes"), flag(2, "line graphics", "9th dot = 8th dot for codes C0h-DFh"), flag(3, "blink enable", "attribute bit 7 blinks", "attribute bit 7 = bright background")] },
    0x11: { name: "Overscan (Border) Color", access: "write", summary: "6-bit colour of the border." },
    0x12: { name: "Color Plane Enable", access: "write", summary: "Which bit planes feed the palette (bits 0-3) and which two colour outputs are visible in Input Status 1 bits 4-5.", fields: [bits(3, 0, "plane n enabled (bit n)"), bits(5, 4, "video status MUX")] },
    0x13: { name: "Horizontal Pel Panning", access: "write", summary: "Shift the image left by 0-8 pixels (smooth horizontal scrolling); combine with CRTC start address for pixel-exact scrolling.", fields: [bits(3, 0, "pixels to shift left")] },
    0x14: { name: "Color Select [std, VGA]", access: "write", summary: "VGA only: high bits of palette index and colour page select." },
  },
};

// ---------------------------------------------------------------- single ports

export interface PortDoc extends RegDoc {
  group: string;
}

export const SINGLE_PORTS: Readonly<Record<number, PortDoc>> = {
  0x3c2: { group: "vga-external", name: "Miscellaneous Output (write) / Input Status 0 (read)", access: "read/write", summary: "WRITE: I/O address select, RAM enable, clock select, odd/even page, sync polarity. READ: bit 7 = vertical retrace/CRT interrupt, bit 4 = switch sense (monitor/adapter config). Reading the current Misc Output on VGA is at 3CCh.", fields: [flag(0, "CRTC I/O address (write)", "3Dx colour addresses", "3Bx mono addresses"), flag(1, "enable RAM (write)", "CPU can access display RAM"), bits(3, 2, "clock select (write)", { 0: "14 MHz (EGA) / 25 MHz (VGA)", 1: "16 MHz (EGA) / 28 MHz (VGA)", 2: "external feature connector clock", 3: "unused" }), flag(5, "odd/even page bit (write)", "high 64 KB page", "low 64 KB page"), flag(6, "horizontal retrace polarity (write)", "negative", "positive"), flag(7, "vertical retrace polarity (write)", "negative", "positive")] },
  0x3cc: { group: "vga-external", name: "Miscellaneous Output (read) [VGA]", access: "read", summary: "Read back of the Miscellaneous Output register written at 3C2h." },
  0x3ca: { group: "vga-external", name: "Feature Control (read) / Graphics 2 Position (EGA write)", access: "read/write", summary: "EGA: Graphics 2 Position register, must be programmed 1. VGA: feature control read-back." },
  0x3c3: { group: "vga-external", name: "Video Subsystem Enable [VGA]", access: "read/write", summary: "Bit 0 enables/disables the VGA's response to memory and I/O.", fields: [flag(0, "VGA enable", "enabled", "disabled")] },
  0x3c6: { group: "vga-dac", name: "DAC PEL Mask [VGA]", access: "read/write", summary: "ANDed with each pixel value before the DAC lookup; normally FFh. Games use it for palette tricks/fades." },
  0x3c7: { group: "vga-dac", name: "DAC Read Index (write) / DAC State (read) [VGA]", access: "read/write", summary: "Write the first palette entry to read through 3C9h; reading returns 0 = write mode, 3 = read mode." },
  0x3c8: { group: "vga-dac", name: "DAC Write Index [VGA]", access: "write", summary: "Write the first palette entry (0-255) to load; then write R,G,B (3 bytes, 6 bits each, 0-63) to 3C9h per entry - the index auto-increments." },
  0x3c9: { group: "vga-dac", name: "DAC Data [VGA]", access: "read/write", summary: "Palette data: each entry is three successive bytes Red, Green, Blue, 6 bits each (0-63). Index auto-increments after the third byte; load a full palette with 768 `OUT`s after one write to 3C8h." },
  0x3da: { group: "vga-external", name: "Input Status 1 (read) / Feature Control (write)", access: "read/write", summary: "Colour-mode status (3BAh in mono). Bit 3 is 1 during vertical retrace (the standard 'wait for vsync' poll); bit 0 is 1 during horizontal or vertical blanking, when CGA video RAM can be updated without snow. NOTE: the bundled IBM EGA manual describes bit 0 with the opposite polarity; common practice (poll until bit 3 set) are used here, verify against the disassembly. Reading this port also resets the Attribute Controller (3C0h) flip-flop to 'address'.", fields: [flag(0, "display/blanking", "blanking (horizontal or vertical retrace): RAM access OK", "active display"), flag(1, "light pen strobe", "triggered"), flag(2, "light pen switch", "open", "closed"), flag(3, "vertical retrace", "in vertical retrace", "displaying")] },
  0x3ba: { group: "vga-external", name: "Input Status 1 (read, mono) / Feature Control (write)", access: "read/write", summary: "Same as 3DAh when the adapter is in monochrome addressing mode (Misc Output bit 0 = 0), and on MDA/Hercules." },
  0x3d8: { group: "cga-mda", name: "CGA Mode Select Register", access: "write", summary: "CGA mode control (also EGA/VGA's CGA emulation).", fields: [flag(0, "text resolution", "80x25 text", "40x25 text"), flag(1, "graphics", "320x200 graphics", "text"), flag(2, "colour burst", "B/W (burst off)", "colour"), flag(3, "video enable", "video signal on", "video off (screen blank)"), flag(4, "640x200 graphics", "640x200 B/W graphics"), flag(5, "blink", "attribute bit 7 blinks", "no blink (bright background)")] },
  0x3d9: { group: "cga-mda", name: "CGA Color Select Register", access: "write", summary: "Border/background colour (text and 320x200 modes) and palette choice. In 320x200 4-colour mode, bit 5 picks palette 1 (cyan, magenta, white) or 0 (green, red, brown) and bit 4 selects the high-intensity variants; bits 0-3 set the background colour.", fields: [bits(3, 0, "border/background colour (RGB+intensity)"), flag(4, "intensity", "high-intensity colours"), flag(5, "palette (graphics)", "palette 1: cyan/magenta/white", "palette 0: green/red/brown")] },
  0x3b8: { group: "cga-mda", name: "MDA Mode Control Register", access: "write", summary: "Monochrome adapter control: bit 0 = 80x25 text, bit 3 = enable video, bit 5 = blink. Hercules adds bit 1 = graphics.", fields: [flag(0, "80x25 text", "set"), flag(1, "graphics [Hercules]", "graphics mode"), flag(3, "video enable", "video signal on"), flag(5, "blink", "blinking on")] },
  0x3bf: { group: "cga-mda", name: "Hercules Configuration Switch [std]", access: "write", summary: "Hercules: bit 0 allows graphics mode, bit 1 allows the upper 32 KB page at B800h. Not in the bundled sources." },
  0x3dd: { group: "tandy-pcjr-video", name: "Tandy/PCjr Extended RAM Page Register", access: "read/write", summary: "Tandy 1000 SX: extended page register used with the CRT page register (3DFh); see the Tandy 1000 SX Technical Reference for the bit layout." },
  0x3de: { group: "tandy-pcjr-video", name: "Tandy/PCjr Video Array Data", access: "read/write", summary: "Data port of the video gate array: palette (16 entries), mode control, border colour. The array register is selected through 3DAh (write after reading 3DAh to reset the address flip-flop)." },
  0x3df: { group: "tandy-pcjr-video", name: "Tandy/PCjr CRT/CPU Page Register", access: "read/write", summary: "Selects which 16 KB block of the first 128 KB of RAM the CPU sees at B800h (CPU page) and where the video controller fetches from (CRT page). INT 10h AH=05h AL=81h-83h sets both; direct OUTs to 3DFh are common in games." },
  0xc0: { group: "sn76496", name: "TI SN76496 Programmable Sound Generator (PCjr/Tandy 1000)", access: "write", summary: "Write-only. Latch byte `1rrrdddd` selects register rrr (0/2/4 = tone 0-2 divider, 1/3/5 = tone volume, 6 = noise control, 7 = noise volume) and gives 4 data bits; a following byte `0xhhhhhh` adds divider bits 9..4. Attenuation: 0 = loud, 15 = off. Tone frequency = 3,579,545 / (32 * divider). Ports C1h-C7h mirror C0h on the original Tandy 1000. Examples: 9Fh mutes tone 0; 8Eh then 0Fh sets tone 0 to divider 254 (A440); E4h = white noise at rate 0. Full table: dosref://port/sn76496." },
  0x40: { group: "pit-speaker", name: "8253/8254 PIT Counter 0 (system timer)", access: "read/write", summary: "Counter 0: drives IRQ0 (INT 08h, 18.2 Hz when the divisor is 0/65536). Games reprogram its divisor (via mode register 43h) to get faster timer ticks: rate = 1,193,182 / divisor." },
  0x41: { group: "pit-speaker", name: "8253/8254 PIT Counter 1 (DRAM refresh)", access: "read/write", summary: "Counter 1: RAM refresh timing on PC/XT; leave alone." },
  0x42: { group: "pit-speaker", name: "8253/8254 PIT Counter 2 (speaker tone)", access: "read/write", summary: "Counter 2 drives the PC speaker: write divisor LSB then MSB (after mode 0B6h to port 43h); tone Hz = 1,193,182 / divisor. Gate it on with port 61h bit 0 and connect it with bit 1." },
  0x43: { group: "pit-speaker", name: "8253/8254 PIT Mode Control Register", access: "write", summary: "Selects counter, access format and mode before writing a divisor to 40h-42h. Common values: 36h (counter 0, LSB+MSB, mode 3), 0B6h (counter 2, LSB+MSB, mode 3: speaker tone), 34h (counter 0 rate generator style).", fields: [flag(0, "BCD", "BCD counter", "16-bit binary counter"), bits(3, 1, "counter mode", { 0: "mode 0 interrupt on terminal count", 1: "mode 1 one-shot", 2: "mode 2 rate generator", 3: "mode 3 square wave", 4: "mode 4 software strobe", 5: "mode 5 hardware strobe", 6: "mode 2 (alias)", 7: "mode 3 (alias)" }), bits(5, 4, "access", { 0: "latch counter value", 1: "MSB only", 2: "LSB only", 3: "LSB then MSB" }), bits(7, 6, "counter select", { 0: "counter 0", 1: "counter 1", 2: "counter 2", 3: "read-back (8254)" })] },
  0x61: { group: "pit-speaker", name: "8255 Port B / system control (speaker gate)", access: "read/write", summary: "PC speaker control and XT keyboard housekeeping. Bit 0 gates PIT counter 2; bit 1 connects counter 2 (or direct bit toggling) to the speaker. Games toggle bits 0-1 for sound; the keyboard-acknowledge idiom sets then clears bit 7 on XT-class machines (read-modify-write preserves the other bits).", fields: [flag(0, "timer 2 gate", "counter 2 counting"), flag(1, "speaker data enable", "speaker connected", "speaker disconnected"), flag(7, "keyboard clear/enable [XT]", "clear keyboard (XT)")] },
  0x60: { group: "keyboard", name: "Keyboard data port (8255 Port A / 8042 buffer)", access: "read/write", summary: "Read in the INT 09h handler to get the key scancode: bit 7 clear = key pressed (make), bit 7 set = released (break, scancode | 80h). E0h/E1h prefix extended keys on AT keyboards. A custom keyboard handler reads this then sends EOI to port 20h.", fields: [bits(6, 0, "scancode"), flag(7, "release", "key released (break)", "key pressed (make)")] },
  0x64: { group: "keyboard", name: "8042 keyboard controller command/status (AT, PS/2)", access: "read/write", summary: "Read: status (bit 0 = output buffer full, bit 1 = input buffer full). Write: controller commands (e.g. 0D1h write output port, used to enable A20).", fields: [flag(0, "output buffer", "data ready at port 60h"), flag(1, "input buffer", "full: wait before writing")] },
  0x20: { group: "pic", name: "8259A Master PIC command/EOI", access: "read/write", summary: "Write 20h (non-specific end-of-interrupt) at the end of every hardware IRQ 0-7 handler (INT 08h-0Fh). Slave PIC (IRQ 8-15, AT) is at A0h; its handlers send EOI to A0h then 20h." },
  0x21: { group: "pic", name: "8259A Master PIC interrupt mask register", access: "read/write", summary: "IMR: a 1 bit masks (disables) that IRQ. Bit 0 timer (IRQ0/INT 08h), 1 keyboard (INT 09h), 2 cascade/EGA retrace, 3 COM2, 4 COM1, 5 LPT2/hard disk, 6 floppy, 7 LPT1.", fields: Array.from({ length: 8 }, (_, i) => flag(i, `IRQ${i}`, "masked (disabled)", "enabled")) },
  0xa0: { group: "pic", name: "8259A Slave PIC command/EOI (AT)", access: "read/write", summary: "Slave PIC for IRQ 8-15 (INT 70h-77h)." },
  0xa1: { group: "pic", name: "8259A Slave PIC interrupt mask (AT)", access: "read/write", summary: "Mask register for IRQ 8-15." },
  0x201: { group: "game-port", name: "Game adapter (joystick)", access: "read/write", summary: "Write anything to start the axis one-shot timers; then poll bits 0-3 (joystick A X/Y, B X/Y) until they fall to 0 - pulse time encodes the position (about 24.2us + 0.011us per ohm). Bits 4-7 are buttons, 0 = pressed.", fields: [flag(0, "joystick A X", "timing active", "timer expired"), flag(1, "joystick A Y", "timing active", "timer expired"), flag(2, "joystick B X", "timing active", "timer expired"), flag(3, "joystick B Y", "timing active", "timer expired"), flag(4, "A button 1", "released", "PRESSED"), flag(5, "A button 2", "released", "PRESSED"), flag(6, "B button 1", "released", "PRESSED"), flag(7, "B button 2", "released", "PRESSED")] },
  0x70: { group: "cmos", name: "CMOS RAM/RTC index (AT, PS/2)", access: "write", summary: "Select a CMOS register (00h seconds ... 0Dh) to read or write through port 71h. Bit 7 also controls NMI masking." },
  0x71: { group: "cmos", name: "CMOS RAM/RTC data (AT, PS/2)", access: "read/write", summary: "Data for the register chosen at port 70h (real-time clock, configuration)." },
  0x388: { group: "adlib", name: "AdLib / OPL2 (YM3812) address/status [std]", access: "read/write", summary: "Write the OPL register number here, then the value to 389h (wait ~3.3us after the register write and ~23us after the data write on real hardware). Read: status (bit 7 = IRQ, bit 6 = timer 1, bit 5 = timer 2); games detect an AdLib by starting the timers and reading this port. Not in the bundled sources." },
  0x389: { group: "adlib", name: "AdLib / OPL2 data [std]", access: "write", summary: "Value for the OPL register chosen at 388h." },
};

/** Single-port lookups only apply to the exact port; indexed families are handled by name. */
export const INDEXED_FILES: readonly IndexedFile[] = [SEQUENCER, GRAPHICS_CONTROLLER, CRTC, ATTRIBUTE];

/** Prose-only group documents (resource tails). */
export const GROUP_NOTES: Readonly<Record<string, string>> = {
  "sn76496": `# TI SN76496 PSG (PCjr / Tandy 1000) — port C0h

Source: "Sounding Off on the 1000" (80 Micro, Jan 1988) programming notes, and the bundled port table (port 0C0 = TI SN76496 on PCjr). Three square-wave tone generators plus one noise generator, each with its own attenuation. Write-only, programmed one byte at a time to port **C0h** (the original Tandy 1000 also decodes C1h-C7h).

| Register | Latch high nibble | Function |
|---:|---|---|
| 0 | 8 | tone 0 divider |
| 1 | 9 | tone 0 attenuation |
| 2 | A | tone 1 divider |
| 3 | B | tone 1 attenuation |
| 4 | C | tone 2 divider |
| 5 | D | tone 2 attenuation |
| 6 | E | noise control |
| 7 | F | noise attenuation |

**Latch byte** \`1 rrr dddd\`: register rrr plus 4 data bits. **Continuation byte** \`0 x hhhhhh\`: bits 9..4 of a tone divider (low 6 bits). The register stays selected until a new latch byte.

**Pitch**: \`N = round(3,579,545 / (32 * f))\` = \`round(111860.78125 / f)\`, 10 bits (1-1023). Example A440: N = 254: write 8Eh then 0Fh to port C0h.
**Volume**: attenuation 0 = loudest, 15 = silent. \`0x90 | atten\` for tone 0, 0xB0 tone 1, 0xD0 tone 2, 0xF0 noise. 9Fh/BFh/DFh/FFh mute everything.
**Noise** byte \`E0h | (type<<2) | rate\`: type 0 = periodic, 1 = white; rate 0-2 fixed (divider 240/480/960 equivalent), 3 = follows tone 2's divider. Noise is silent until register 7 is unmuted.
Some later Tandy models (SL/TL) add other sound hardware; the SN76496 interface above is the part covered by the bundled notes.`,
  "vga-external": `# EGA/VGA external registers

| Port | Read | Write |
|---|---|---|
| 3C2h | Input Status 0 | Miscellaneous Output |
| 3CCh | Miscellaneous Output (VGA) | - |
| 3DAh (colour) / 3BAh (mono) | Input Status 1 | Feature Control |
| 3C3h | Video subsystem enable (VGA) | same |

Miscellaneous Output bit 0 decides whether the CRTC and Input Status 1 live at 3Dx (colour) or 3Bx (mono). Standard VGA colour modes write 63h/67h/E3h-style values here (bit 0 = 1, RAM enabled, bit 6/7 sync polarity encode 350/400/480 lines).
Waiting for vertical retrace: \`IN AL,DX\` from 3DAh until bit 3 is set (and first until it is clear, to catch the start).`,
  "vga-dac": `# VGA DAC (palette) — ports 3C6h-3C9h

- 3C8h: write palette index N (0-255) to start loading at entry N.
- 3C9h: write R, G, B (6-bit values 0-63) per entry; index auto-increments after each triple. 768 consecutive writes load the whole palette.
- 3C7h: write index to start reading entries through 3C9h; read = DAC state.
- 3C6h: PEL mask (normally FFh).
BIOS alternative: INT 10h AX=1010h (set one DAC register), AX=1012h (block). EGA has no DAC: colours go through the 16 Attribute Controller palette registers instead (6-bit rgbRGB).`,
  "cga-mda": `# CGA / MDA / Hercules registers

- 3D4h/3D5h: 6845 CRTC (3B4h/3B5h on mono). 3D8h mode select, 3D9h colour select, 3DAh status (3B8h/3BAh on mono). Ports 3D0-3D7 mirror the CRTC index/data pair.
- CGA mode select (3D8h): bit 0 80-column text, bit 1 320x200 graphics, bit 2 colour burst off, bit 3 video enable, bit 4 640x200 mono, bit 5 blink.
- Writing CGA video RAM during active display produces snow on real CGA cards: wait for 3DAh bit 0 (blanking) or bit 3 (vertical retrace). EGA/VGA do not need this.`,
  "tandy-pcjr-video": `# Tandy 1000 / PCjr video gate array — ports 3DAh, 3DDh-3DFh

Source: Tandy 1000 SX Technical Reference (video memory map table): 3D4/3D5 6845 address/data, 3D8 mode select, 3D9 color select, 3DA video array address and status, 3DB/3DC light pen latches, **3DD extended RAM page register**, **3DE video array data**, **3DF CRT processor page register**. The 16-entry palette and mode/border registers are programmed through the array pair 3DAh (index, after reading 3DAh to reset the flip-flop) / 3DEh (data). Memory layout per mode: dosref://memory/cga-text-graphics.`,
  "pit-speaker": `# 8253/8254 timer and the PC speaker

Counter 0 (40h) = system tick; counter 1 (41h) = DRAM refresh; counter 2 (42h) = speaker. Mode control at 43h. Input clock 1,193,182 Hz: frequency = 1,193,182 / divisor.
Speaker tone: \`OUT 43h,0B6h\`; \`OUT 42h,lo\`; \`OUT 42h,hi\`; set bits 0-1 of port 61h to turn it on, clear them to stop. Timer speed-ups: \`OUT 43h,36h\` then divisor to 40h (chain to the original INT 08h handler at the old rate to keep DOS time).`,
  "pic": `# 8259A interrupt controllers

Master 20h/21h (IRQ0-7 -> INT 08h-0Fh); slave A0h/A1h on AT and later (IRQ8-15 -> INT 70h-77h, cascaded through IRQ2). End of interrupt: \`OUT 20h,20h\` (plus \`OUT A0h,20h\` first for IRQ8-15). Port 21h bit n set = IRQn disabled.`,
  "keyboard": `# Keyboard

INT 09h (IRQ1) handler reads the scancode from port 60h; custom handlers replace it (INT 21h AH=25h AL=09h) and finish with \`OUT 20h,20h\`. Bit 7 of the scancode = key release. On XT-class machines acknowledge by pulsing port 61h bit 7. AT/PS/2: 8042 at 60h/64h.`,
  "game-port": `# Game port (201h)

Write any value to start the one-shot timers, then poll bits 0-3 until they drop; the loop count is the axis position. Buttons are bits 4-7 (0 = pressed). Time = 24.2us + 0.011us * resistance.`,
  "cmos": `# CMOS RAM / RTC (AT, PS/2)

Index port 70h, data port 71h. 00h seconds, 02h minutes, 04h hours, 07h day, 08h month, 09h year, 0Ah-0Dh status registers; 10h+ configuration (drive types, memory size). Bit 7 of port 70h masks NMI.`,
  "adlib": `# AdLib / Sound Blaster FM (OPL2) — ports 388h/389h

Not covered by the bundled sources; standard PC-audio facts. Write register number to 388h, value to 389h with small delays between. Sound Blaster cards expose the same OPL at base+8/base+9 (220h default: 228h/229h) and the DSP at base+6 (reset), base+0Ah (read data), base+0Ch (write data/status), base+0Eh (read status).`,
};
