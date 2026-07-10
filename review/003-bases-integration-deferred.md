# Tier B — Obsidian Bases integration deferred (Phase 5)

**Status:** deferred pending API confirmation, not a blocker.

docs/03 Phase 5 lists "Obsidian Bases integration (locations as a base view) if
Bases API allows." Deferred because it is gated on the Bases plugin API surface,
which needs a spike to confirm it exposes what's needed (registering a custom view
over notes filtered by `map:` frontmatter) before committing to a build.

**Note:** locations are already ordinary notes with structured frontmatter, so a
Bases/Dataview view over them largely works today without plugin code — this is a
convenience integration, not a capability gap.

**Awaiting Jonah:** whether to spike the Bases API now or leave locations-as-notes
to be queried via Bases/Dataview directly.
