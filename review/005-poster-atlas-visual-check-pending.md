# Tier B — poster/atlas render output not yet eyeballed

**Status:** wired + unit-tested; visual output pending a human/CLI render.

- Poster export (007) produces a high-res PNG via an offscreen `preserveDrawingBuffer`
  map; the command, dimensions math, and Vault-adapter write are done and unit-tested,
  but the actual PNG has not been visually inspected.
- Atlas export (008) produces a PDF (cover map + gazetteer) via pdf-lib; same status.

**Awaiting Jonah:** run "Export map poster" / "Export map atlas" on Ashfall (and a
handcrafted theme + London) and confirm the output looks right — title cartouche,
resolution, gazetteer legibility, PDF opens in a standard reader.
