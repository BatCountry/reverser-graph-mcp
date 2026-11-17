// Real-mode PC memory map, authored from the interrupt list and bundled references plus standard PC hardware
// documentation. `summary` goes inline in tool results (short, answers "what lives here");
// `detail` is served as a resource (addressing formulas, caveats, cross references).

export interface Region {
  id: string;
  /** inclusive linear (20-bit; HMA goes to 0x10FFEF) addresses */
  start: number;
  end: number;
  name: string;
  /** one-line role, shown as `role` in tool output */
  role: string;
  summary: string;
  detail: string;
}

export const REAL_MODE_MAX = 0x10ffef;

export const REGIONS: readonly Region[] = [
  {
    id: "ivt",
    start: 0x00000,
    end: 0x003ff,
    name: "Interrupt Vector Table (IVT)",
    role: "256 far pointers (4 bytes each) giving the handler address for INT 00h-FFh",
    summary:
      "The IVT is a table of 256 entries starting at 0000:0000. Entry n lives at linear address 4*n: a 16-bit offset (IP) followed by a 16-bit segment (CS), so `INT n` does a far call to CS:IP read from there. " +
      "Programs change a vector with INT 21h AH=25h (set) and read it with AH=35h (get); code that writes 0000:xxxx directly is hooking an interrupt by hand (resident drivers, copy protection, custom bootloaders).",
    detail: `# Interrupt Vector Table (0000:0000 - 0000:03FF)

- 256 entries x 4 bytes = 1 KB. Vector **n** is at linear address \`n*4\`: word at +0 = offset (IP), word at +2 = segment (CS).
- \`INT n\` pushes FLAGS, CS, IP, clears IF/TF, then loads CS:IP from the vector. \`IRET\` returns.
- Hardware IRQs 0-7 arrive at INT 08h-0Fh, IRQ 8-15 at INT 70h-77h (AT and later).
- Set vector: INT 21h AH=25h (AL=vector, DS:DX=handler). Get vector: INT 21h AH=35h (AL=vector, returns ES:BX). Direct writes to 0000:n*4 do the same without DOS.
- Several vectors do not point at code but at data tables: INT 1Dh (video parameter table), INT 1Eh (diskette parameter table), INT 1Fh (graphics font for chars 80h-FFh), INT 41h/46h (fixed disk parameter tables), INT 43h (user graphics font, EGA/VGA).
- INT 22h/23h/24h hold the terminate, Ctrl-Break and critical-error handlers; DOS also saves them inside the PSP (see dosref://memory/psp).
- Slot index for a given vector: byte offset = vector * 4. Example: INT 21h is at 0000:0084, INT 10h at 0000:0040, INT 33h at 0000:00CC.

Use the \`interrupts\` tool to look up what a particular vector is for.`,
  },
  {
    id: "bda",
    start: 0x00400,
    end: 0x004ff,
    name: "BIOS Data Area (BDA, 0040:0000)",
    role: "BIOS working variables: COM/LPT ports, equipment flags, keyboard buffer, video state, timer tick count",
    summary:
      "256 bytes at segment 0040h filled in by the BIOS: serial/parallel port addresses (40:00-0F), equipment word (40:10, INT 11h), conventional memory size in KB (40:13, INT 12h), keyboard flags and ring buffer (40:17-1E+), " +
      "current video mode (40:49), columns (40:4A), active page (40:62), CRTC port (40:63), timer tick counter (40:6C, INT 1Ah). Games read these instead of calling the BIOS (e.g. polling 40:6C for timing, 40:17 for shift keys).",
    detail: `# BIOS Data Area (0040:0000 - 0040:00FF, linear 0400-04FF)

A full field table is at dosref://memory/bda. Frequently used by programs:

| Address | Meaning |
|---|---|
| 0040:0010 | equipment flags (INT 11h result) |
| 0040:0013 | memory size in KB (INT 12h result) |
| 0040:0017 / 0018 | keyboard shift/lock flag bytes |
| 0040:001A / 001C | keyboard buffer head / tail (offsets from 0040:0000); buffer at 0040:001E, 32 bytes |
| 0040:0049 | current video mode |
| 0040:004A | text columns |
| 0040:004E | offset of the current page in the video buffer |
| 0040:0062 | active display page |
| 0040:0063 | CRTC base port (3D4h colour, 3B4h mono) |
| 0040:006C | timer tick count since midnight (dword, ~18.2065 Hz; INT 08h increments it) |
| 0040:0084 / 0085 | text rows-1 / character height (EGA+) |

Real-mode code reaches it via ES=0040h or by absolute segment 0000:04xx. Custom bootloaders run before the BIOS data area is trustworthy only on non-PC-compatible hardware; on a normal PC it is already initialised when the boot sector runs.`,
  },
  {
    id: "dos-comm",
    start: 0x00500,
    end: 0x005ff,
    name: "DOS / BASIC communication area (0050:0000)",
    role: "DOS and ROM-BASIC scratch bytes: print-screen status, BASIC state, DOS diskette mode",
    summary:
      "256 bytes at 0050:0000 used by DOS and ROM BASIC: 0050:00 is the PrintScreen status byte (00 idle, 01 in progress, FF error), 0050:04 the single-floppy-mode flag, plus BASIC's DEF SEG and handler pointers. Rarely touched by games.",
    detail: `# DOS / BASIC communication area (0050:0000)

Field list is included at dosref://memory/bda under segment 50. Notable: 0050:00 PrintScreen status; 0050:04 single diskette mode flag; 0050:10 BASIC DEF SEG value; 0050:12/16/1A pointers to BASIC INT 1Ch/23h/24h handlers.`,
  },
  {
    id: "conventional",
    start: 0x00600,
    end: 0x9ffff,
    name: "Conventional memory (DOS kernel, drivers, program)",
    role: "RAM available to DOS and programs (up to 640 KB); each program starts with a 256-byte PSP",
    summary:
      "Conventional RAM: DOS kernel and resident drivers low, then the loaded program and free memory up to 9FFFFh (640 KB). A program's load segment starts with a 256-byte Program Segment Prefix (PSP); .COM code begins at PSP:0100, .EXE code at PSP+10h segments. DS=ES=PSP segment on entry to an .EXE.",
    detail: `# Conventional memory (0000:0600 - 9000:FFFF)

- DOS allocates memory in **paragraphs** (16 bytes) via INT 21h AH=48h/49h/4Ah; blocks are chained by Memory Control Blocks (MCBs).
- A loaded program begins with the **PSP**: 256 bytes, layout at dosref://memory/psp. For a .COM file: CS=DS=ES=SS=PSP segment, IP=0100h, the image is the PSP plus 0100h bytes of offset. For an .EXE: DS=ES=PSP segment, CS:IP and SS:SP come from the header relative to PSP segment + 10h.
- The command tail is at PSP:0080 (length byte, then text); the environment block segment is the word at PSP:002C.
- The amount of memory reported by INT 12h (and word 0040:0013) is how much of this range is usable (in KB).
- A000h:0000 is the first byte *above* this range: segment 9FFFh is the last full paragraph block.`,
  },
  {
    id: "ega-vga-graphics",
    start: 0xa0000,
    end: 0xaffff,
    name: "EGA/VGA graphics memory (segment A000h)",
    role: "Framebuffer for EGA/VGA graphics modes 0Dh-13h (64 KB window)",
    summary:
      "Graphics framebuffer for EGA/VGA. Mode 13h (320x200, 256 colours): one byte per pixel, linear, offset = y*320 + x (64,000 bytes). Planar 16-colour modes 0Dh/0Eh/10h/12h: four 1-bit planes share the same A000:0000 addresses (8 pixels per byte, 80 bytes per 640-wide row); " +
      "which plane a write hits is set through the VGA Sequencer Map Mask (port 3C4h index 2) and reads through the Graphics Controller Read Map Select (3CEh index 4). 'Mode X' unchains this into 4 interleaved planes (pixel x goes to plane x&3, offset = y*80 + x/4 for 320x240).",
    detail: `# A000:0000 - A000:FFFF: EGA/VGA graphics

**Mode 13h** (VGA/MCGA, 320x200x256): linear, \`offset = y*320 + x\`, 64,000 bytes. Palette: DAC ports 3C8h (write index) / 3C9h (R,G,B 6-bit each), or INT 10h AX=1010h.

**Planar 16-colour modes** (EGA/VGA): modes 0Dh (320x200), 0Eh (640x200), 0Fh (640x350 mono), 10h (640x350), 12h (640x480 VGA). Four bit planes overlay the same 64 KB window.
- Pixel address: \`offset = y*bytesPerRow + (x >> 3)\`, bit \`7 - (x & 7)\`; bytesPerRow is 40 (mode 0Dh) or 80 (0Eh/0Fh/10h/12h).
- Writes: select planes with the Sequencer Map Mask (port 3C4h, index 02h); write mode and bit mask through the Graphics Controller (3CEh index 03h, 05h, 08h).
- Reads: Graphics Controller Read Map Select (3CEh index 04h), or colour compare via Read Mode 1.
- Display pages: BIOS pages in these modes are 2000h (0Dh), 4000h (0Eh), 8000h (0Fh/10h) bytes apart; the video mode table (dosref://memory/video-modes) lists how many pages each mode supports.

**Unchained 256-colour ("Mode X")**: clear the Chain-4 bit in the Sequencer Memory Mode register (3C4h index 04h), then pixel x is stored in plane (x & 3) at \`offset = y*80 + (x >> 2)\` for 320x240.

**Text modes do not use this segment** (see B800 for colour text, B000 for mono).

Mode numbers, resolutions and which segment each uses: dosref://memory/video-modes.`,
  },
  {
    id: "mda-hercules",
    start: 0xb0000,
    end: 0xb7fff,
    name: "Monochrome text / Hercules graphics (segment B000h)",
    role: "MDA text (mode 7) and Hercules 720x348 monochrome graphics; also VGA mono text",
    summary:
      "MDA/Hercules/VGA mode 07h text lives here: 80x25 cells of 2 bytes (character, attribute), 4000 bytes at B000:0000. Hercules graphics (720x348, 1 bit/pixel) uses B000:0000-7FFF with four interleaved 8 KB banks (offset = 2000h*(y&3) + 90*(y>>2) + (x>>3)); its second page is at B800:0000.",
    detail: `# B000:0000 - B000:7FFF: monochrome adapters

- **MDA text (mode 07h)**: 80x25, 2 bytes per cell: \`offset = (row*80 + col)*2\` -> character, +1 attribute. Typical attributes: 07h normal, 0Fh bright, 70h reverse video, 01h underline, 87h/F0h blinking variants. CRTC at ports 3B4h/3B5h; mode control 3B8h; status 3BAh.
- **Hercules graphics (720x348 mono)**: 90 bytes per row, rows interleaved in four 2000h-byte banks: \`offset = 0x2000*(y & 3) + 90*(y >> 2) + (x >> 3)\`, MSB = leftmost pixel. Config port 3BFh selects whether the upper page at B800:0000 is enabled.
- VGA mode 07h (720x400 text) also uses B000.
- A system with both a colour and a monochrome adapter (dual monitor) places the second adapter here.

Mode list: dosref://memory/video-modes.`,
  },
  {
    id: "cga-text-graphics",
    start: 0xb8000,
    end: 0xbffff,
    name: "Colour text and CGA/PCjr/Tandy graphics (segment B800h)",
    role: "Colour text modes 00h-03h (also on EGA/VGA) and CGA-style graphics modes 04h-06h; Tandy/PCjr 16-colour modes",
    summary:
      "Colour text modes 0-3 (and CGA graphics modes 4-6) live here. Text: 2 bytes per cell (char, attribute: low nibble foreground, bits 4-6 background, bit 7 blink/bright-bg); an 80x25 page is 4000 bytes, BIOS pages are 1000h apart (800h for 40-column). " +
      "CGA graphics (modes 04h/05h 320x200x4 at 2 bits/pixel, 06h 640x200x2 at 1 bit/pixel): even scanlines at B800:0000, odd at B800:2000, offset = 2000h*(y&1) + 80*(y>>1) + (x>>2) in 320-wide mode, (x>>3) in 640-wide. " +
      "Tandy 1000 / PCjr 16-colour modes 08h/09h/0Ah also use B800: mode 09h (320x200x16) is 4 interleaved 8000-byte banks (offset = 2000h*(y&3) + 160*(y>>2) + x/2, high nibble = left pixel); mode 08h uses 2 banks (80 bytes/row).",
    detail: `# B800:0000 - B800:7FFF (to BFFF): colour text and CGA-compatible graphics

**Text (modes 00h-03h)**: \`offset = pageBase + (row*columns + col)*2\`; byte 0 = character (code page 437), byte 1 = attribute: bits 0-3 foreground, 4-6 background, bit 7 blink (or bright background when the blink bit is disabled, INT 10h AX=1003h BL=0). 80x25 page = 4000 bytes, BIOS page stride 1000h; 40x25 stride 800h. Pages available per mode: dosref://memory/video-modes.

**CGA 320x200x4 (modes 04h/05h)**: 2 bits per pixel, 4 pixels per byte, leftmost pixel in the top two bits, 80 bytes per scanline. Scanlines are interleaved: even rows from B800:0000, odd rows from B800:2000. \`offset = 0x2000*(y & 1) + 80*(y >> 1) + (x >> 2)\`, shift \`6 - 2*(x & 3)\`. Palette/background via port 3D9h (Color Select): bit 5 selects palette 1 (cyan/magenta/white) vs 0 (green/red/brown), bit 4 intensity, bits 0-3 background colour. Mode Control at 3D8h.

**CGA 640x200x2 (mode 06h)**: 1 bit per pixel, same interleave: \`offset = 0x2000*(y & 1) + 80*(y >> 1) + (x >> 3)\`.

**Tandy 1000 / PCjr** (modes 08h 160x200x16, 09h 320x200x16, 0Ah 640x200x4; Tandy 1000 SL/TL also 0Bh 640x200x16). Source: Tandy 1000 SX Technical Reference Manual (graphics memory usage). All 200-line modes use 2 or 4 banks of 8000 bytes (each bank at a 2000h stride; pixel (0,0) is at offset 0):
- **4 banks** (32 KB; modes 09h and 0Ah): bank = scanline & 3, banks at 0000h / 2000h / 4000h / 6000h, 160 bytes per scanline, \`offset = 0x2000*(y & 3) + 160*(y >> 2) + byteInRow\`. Mode 09h: 2 pixels per byte, high nibble = first (leftmost) pixel, low nibble = second. Mode 0Ah (4 colours at 640 wide): each pixel is two bits split across an even byte (colour bit 0) and the following odd byte (colour bit 1).
- **2 banks** (16 KB; modes 08h, and the CGA-compatible 04h/05h/06h): even scanlines at 0000h, odd at 2000h, 80 bytes per scanline, \`offset = 0x2000*(y & 1) + 80*(y >> 1) + byteInRow\`. Mode 08h is 2 pixels per byte (high nibble first).
- Two registers move the window: the **CPU page register** picks which 16 KB block of the first 128 KB of RAM appears at B800h, the **CRT page register** (port 3DFh) sets where the video controller scans from; the extended RAM page register is port 3DDh. INT 10h AH=05h AL=81h/82h/83h sets them from software. Palette (16 entries) is remapped through the video array registers (3DAh index, 3DEh data).
- The manual's own heading for the 4-bank layout is garbled in the available scan (it lists "16 Color Medium Resolution 640 X 200"); the 4-bank/160-byte stride matches mode 09h (320 pixels at 2 per byte = 160 bytes), so treat 09h as 4-bank.

**EGA/VGA** use this segment for text modes 00h-03h and CGA-compatible modes 04h-06h as well; their native graphics modes are at A000h (dosref://memory/ega-vga-graphics).`,
  },
  {
    id: "video-bios-rom",
    start: 0xc0000,
    end: 0xc7fff,
    name: "Video adapter BIOS ROM (C000h)",
    role: "EGA/VGA option ROM (up to 32 KB); signature 55AAh at C000:0000",
    summary:
      "The video card's own BIOS: starts with 55h AAh and a length byte, entry point at C000:0003. INT 10h is vectored here after POST. Vendor/chipset detection (Paradise 'VGA=', Oak 'OAK VGA', ATI '761295520' signatures in the interrupt list, INT 10h AH=00h) reads strings from this ROM. VGA 8x16/8x14 fonts live inside it; INT 10h AX=1130h returns a pointer to them.",
    detail: `# C000:0000 - C000:7FFF: video BIOS

- Option ROM header: bytes 55h AAh, then size in 512-byte blocks, then an entry point (far-jumped by POST).
- INT 10h normally points into this ROM once POST has installed it.
- To obtain font pointers do not hard-code ROM offsets: use INT 10h AX=1130h (BH selects 8x14 / 8x8 / 8x16 / 9x14 etc.), which returns ES:BP.
- Rarely referenced directly by games except for adapter detection.`,
  },
  {
    id: "option-rom-umb",
    start: 0xc8000,
    end: 0xeffff,
    name: "Upper memory area (option ROMs, EMS page frame, UMBs)",
    role: "Adapter ROMs (C800h hard disk BIOS) and, under EMM386/XMS, EMS page frame and upper memory blocks",
    summary:
      "The upper memory area between video (C000h) and system BIOS (F000h): hard disk adapter BIOS at C800h, other option ROMs on 2 KB boundaries, and - when EMS/UMB managers run - the 64 KB EMS page frame (often D000h or E000h) and upper memory blocks. Contents vary per machine.",
    detail: `# C800:0000 - E000:FFFF: upper memory area

- C800h hard disk adapter ROM (XT format at C800:0005), D000h cluster adapter ROM, D800h PCjr cartridge address, E000h expansion ROM space (hard-wired on AT+).
- The EMS 3.2/4.0 page frame (four 16 KB pages = 64 KB) is typically at D000h or E000h; find it via INT 67h AH=41h (get page frame segment). See \`interrupts\` with interrupt 0x67.
- Contents are machine-dependent; a lookup here only tells you the conventional use.`,
  },
  {
    id: "system-bios-rom",
    start: 0xf0000,
    end: 0xfffff,
    name: "System BIOS ROM (F000h)",
    role: "Motherboard BIOS: ROM BASIC (AT), POST, INT service routines, ROM fonts, reset vector at FFFF:0000",
    summary:
      "The system ROM: F000h region begins with F000:0000 system monitor/expansion ROM, ROM BASIC around F600h on ATs, the BIOS proper from FC00h, ROM 8x8 character table at F000:FA6E, and the CPU reset vector at FFFF:0000 (a far JMP to the POST entry). FFFF:0005 holds the 8-byte BIOS date, FFFF:000E the machine ID byte (e.g. FCh = AT, FFh = original PC).",
    detail: `# F000:0000 - F000:FFFF (and FFFF:0000)

Layout: F000:0 system monitor ROM; F400:0 system expansion ROMs; F600:0 IBM ROM BASIC (AT); F800:0 PCjr cartridge override; FC00:0 BIOS ROM; FF00:0 system ROM; FFA6:E ROM graphics character table; FFFF:0 ROM bootstrap (reset vector); FFFF:5 ROM date (8 bytes, not on all clones); FFFF:E machine ID byte.

- **ROM 8x8 font**: F000:FA6E, 1024 bytes = characters 00h-7Fh, 8 bytes each (top row first, MSB = leftmost pixel). INT 1Fh points to the *second* half (80h-FFh) when a graphics mode needs it. Do not hard-code FA6E in portable code: INT 10h AX=1130h BH=3 returns the pointer, but old games often use it directly.
- **Machine ID** at F000:FFFE: FFh PC, FEh XT, FDh PCjr, FCh AT, FAh PS/2 Model 30, F8h PS/2 Model 80 (INT 15h AH=C0h returns a fuller model table on later machines).
- **Reset vector**: on power-up the 8088 starts at FFFF:0000; this is the only place the CPU executes before the BIOS - relevant for custom boot code that wants to chain to the BIOS.
- INT 19h (bootstrap loader) loads the first sector of the boot device to 0000:7C00 (07C0:0000) and jumps to it.`,
  },
  {
    id: "hma",
    start: 0x100000,
    end: REAL_MODE_MAX,
    name: "High Memory Area (HMA)",
    role: "The 64 KB - 16 byte just above 1 MB, reachable from real mode as FFFF:0010-FFFF:FFFF when A20 is enabled",
    summary:
      "FFFF:0010 through FFFF:FFFF address 100000h-10FFEFh when the A20 gate is enabled (286+). DOS=HIGH loads the kernel here; with A20 off the addresses wrap to 0000:0000.",
    detail: `# 1000:0000 - 10FF:EF (HMA)

Reachable only on 286+ with A20 enabled (XMS driver functions 01h-03h, via INT 2Fh AX=4310h to get the XMS entry point). With A20 disabled the same segment:offset pairs wrap to low memory (the 8086 behaviour), which some old copy-protection and demo code deliberately exploits.`,
  },
];

/** Narrower, named locations inside the big regions above. */
export const LANDMARKS: ReadonlyArray<{ start: number; end: number; name: string; note: string }> = [
  { start: 0x7c00, end: 0x7dff, name: "Boot sector load address (0000:7C00 / 07C0:0000)", note: "INT 19h reads the boot sector here (512 bytes) and jumps to it; custom game bootloaders start executing at this address." },
  { start: 0xffa6e, end: 0xffe6d, name: "ROM 8x8 character table (F000:FA6E)", note: "1024 bytes: glyph bitmaps for characters 00h-7Fh, 8 bytes each." },
  { start: 0xffff0, end: 0xffff4, name: "CPU reset vector (FFFF:0000)", note: "Power-on entry: usually a far JMP into the BIOS POST." },
  { start: 0xffff5, end: 0xffffc, name: "BIOS date string (FFFF:0005)", note: "8 ASCII bytes 'MM/DD/YY'; absent on some clones." },
  { start: 0xffffe, end: 0xffffe, name: "Machine ID byte (FFFF:000E)", note: "FFh PC, FEh XT, FDh PCjr, FCh AT, FAh PS/2 Model 30, F8h PS/2 Model 80." },
];
