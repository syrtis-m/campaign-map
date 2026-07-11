# v3.1 — growth loop, euro-medieval (Tier B review)

**Screenshots:** `review/v3.1-vespergate-growth.png` (domain-framed),
`review/v3.1-vespergate-warren-close.png` (street level, ~100 m scale — the
one to judge).

**Tier A:** 11/11 live (`scripts/gates/procgen31.ts`) on top of the Vitest
gates: byte-determinism with growth, 2×2 seams, junction histogram
(918 T vs 484 four-way), dangling < 0.15, 200-domain fuzz zero-throw
(~94 ms/domain), budget ≤ 2 s (measured **~87 ms** at radius 900 —
the lazy cost field made the whole network 16× faster than v3.0's
skeleton alone).

**What the close-up shows:** an organic, connected warren — T-junctions,
curvature, blocks-in-the-making between streets, streets stopping at the
sketched river and wall. The F1 "fur" failure class is dead: this is a
street *network*, not a line texture.

**Questions/observations for Jonah:**
1. **Density asymmetry across the river.** Growth only crosses water where
   Stage-A arterials bridged, so the NE bank (where more arterials land) is
   much denser than the SW. Reads plausibly medieval to me, but if you want
   both banks urban, v3.3's cityness shaping (canon-location bumps,
   outskirts ribbons) is where the lever lands — flag it now if it bothers
   you so v3.3 prioritizes it.
2. Street-level line width at ink-soot: the warren reads well zoomed in;
   at domain-framing zoom the 1 px floor keeps it quiet. Real class→width
   ramp pass is v3.4.

**Fixture state:** Vespergate's Generated.json left empty (all generated
state cleared after screenshotting) — the sketched fabric demo is untouched.
