"""Byte-level analysis of Turbo Pascal MZ executables with INT 3Fh overlays (and other 16-bit DOS programs).

Modules:
  binary  MZ header and INT 3Fh overlay stub-table/OVR parsing, address spaces, stub resolution
  x86     16-bit instruction decoding and control-transfer classification (capstone)
  flow    recursive descent, non-returning analysis, address-taken procedures, control dependence
  emit    call-graph JSON, per-function listings and README for a generated tree
"""
