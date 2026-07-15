# Plan 039 — Typed location pins as generation attractors (FUTURE)

**Status:** FUTURE — explicitly deferred by Jonah (2026-07-14): "a future item, a separate plan."
Not part of the 031–038 arc; do not schedule without a fresh ruling. Recorded now so the design
context survives.

**Depends:** 034 (canon pins as stage −1 source nodes — that half lands with the unified pass
regardless and is NOT deferred; this plan is only the attractor behaviors). **Read first:**
`plans/research-generation-pipeline.md` §2 (settlement cluster, canon-pins row) and §9 Q7.

## 0. What this is

Today canon Location pins are obstacles: generators route around them, and moving a pin
regenerates nearby regions. This plan makes a pin's `type:` frontmatter ATTRACT generation —
one-way only (pins shape fabric; generation never creates/moves/names pins; no-canonization stays
locked):

1. **`market` pin inside a district → plaza snap** (highest payoff, smallest code): the generated
   plaza + arterial star anchor to the pin, generalizing the shipped `center` param. Precedence:
   explicit `params.center` > typed pin > computed center. City version bump.
2. **`temple`/`landmark` pin → forecourt**: a landmark-sized block carve + parvis at the pin.
3. **`gate` pin on/near the wall ring → forced gate** with an arterial aimed at it.

Untyped pins keep today's route-around behavior. All snapping is closed-form nearest-point on
quantized positions — no new seed derivation, determinism unaffected.

## 1. When picked up

Ship §1.1 (market snap) first and alone; prove the pattern before temple/gate variants.
Verification (headless — no live gates): fixture tests (typed pin ⇒ plaza at pin, precedence order
asserted; pin move ⇒ single forward pass, city adapts; untyped pin behavior byte-identical),
goldens under a city version bump, playground eyeball.

## 2. Boundary (standing)

The tempting reverse edge — city output auto-creating/naming Location notes (wards, landmarks) —
stays rejected; the GM-triggered populate-area flow reading generated fabric is the sanctioned
path for naming.
