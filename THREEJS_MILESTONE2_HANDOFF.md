# Three.js migration handoff — Milestones 2, 3, 4

Read this before touching `src/game/gfx/three/`. This replaces `THREEJS_MILESTONE1_HANDOFF.md`
(deleted — Milestone 1 is done). Update this file's own "done" sections as later milestones land,
rather than deleting it, until Milestone 4 (the last one currently planned) is done — it's a
handoff note, not permanent documentation, but it now covers the whole rest of the migration, not
just the next step.

## What's accomplished, in one paragraph

**Milestone 1 is fully done and verified**: `ThreeBattleRenderer` (`src/game/gfx/three/`)
replaces the ground/terrain canvas with real hex geometry, ground/behind-layer decorations, and
now fully animated unit sprites (walk/attack/cast/counter poses, live idle motion, fade
opacity) — pixel-parity with the existing Canvas2D-shim renderer, verified by
`npm run typecheck && npm run build && npm run test` plus headless-Playwright visual checks.
**Three.js is now the default ground renderer** (`?renderer=legacy` opts back out to the old
Canvas2D-shim path for comparison) — it started opt-in via `?renderer=three`, flipped to default
once Milestone 1 was confirmed.

**Milestone 2 is implemented and gate-clean, but STILL not yet user-confirmed**:
`ThreeBattleRenderer` now has a real `DirectionalLight` + `HemisphereLight`, terrain uses
`MeshLambertMaterial` so it can receive shadows, and every unit/decoration gets an invisible
per-instance shadow-caster box (synthetic elevation, see
`UNIT_SHADOW_HEIGHT_SCALE`/`DECOR_SHADOW_HEIGHT_SCALE`) whose shadow lands in the exact same
screen-space direction the old fake Canvas2D ellipse shadow used (see `SUN_DIRECTION`'s comment)
— that fake ellipse is now skipped under the Three renderer only (`skipUnitShadow` param, legacy
Canvas2D path unchanged). Verified two ways: (1) a stress test (elevation/intensity cranked way
up) produced unmistakable, correctly-angled cast shadows, proving the mechanism works; (2) dialed
back down to conservative default intensities, which are intentionally subtle per the caution
below. All three gate commands pass clean.

**2026-09-21 session: user checked it in their own browser and found three real bugs, all now
fixed** (see git log — "Fix Three.js renderer: zoom-scaled terrain and missing move/attack grid"):
1. **Terrain froze at its old scale/position on zoom, decorations and units didn't** —
   `ensureBuilt`'s rebuild check only compared `cols`/`rows`/`missionId`, not `tile` (which
   changes with zoom), while `ensureDecorBuilt` already keyed on `tile`. Reported as "tiles
   disappear when I zoom in" / "it's like all props change position as I zoom in". Fixed: `tile`
   is now part of `ensureBuilt`'s rebuild identity too.
2. **No movement/attack/spell-range grid at all under the Three renderer.** That highlight (plus
   the active-turn glow) was never a thing of its own — it was the tail end of `renderGround`,
   drawn straight onto the ground canvas, which `ThreeBattleRenderer` replaces with a WebGL
   context (a canvas can't host both a WebGL and a 2D context). Fixed: extracted into
   `BattleEngine.renderBoardOverlays(ctx, cssW, cssH)`, called by `BattleCanvas.tsx` against a new
   dedicated transparent canvas stacked between the ground canvas and the units canvas (so units
   still draw on top of the highlight, same order as the legacy path).
3. **Screen shake (`trauma`) was silently dead under the Three renderer** — found while fixing
   #2, not user-reported yet. The random per-frame shake offset was only ever rolled inside
   `renderGround`, which `renderUnitsAndOverlays` read back out via `frameShakeDx/Dy` — fine on
   the legacy path, but `renderGround` never runs under Three, so those stayed frozen at their
   last (or default 0) value. Fixed: the randomization moved into `updateCameraLayout`, which both
   render paths call every frame.

**Still true**: this milestone has not had a clean user sign-off yet — the three bugs above were
found on the user's own first look. The next session should confirm with the user whether they've
now checked it and it looks right before treating Milestone 2 as actually done and starting
Milestone 3.

**A real Three.js gotcha found along the way (see its own section below)**: this Three.js
version's `WebGLShadowMap` filters shadow-casters using the *main viewing camera's* `layers`, not
the light's own `shadow.camera.layers` — so the common "put invisible shadow-only objects on a
layer the shadow camera alone enables" trick silently excludes them from the shadow map entirely,
with no error. The fix used here: `colorWrite: false, depthWrite: false` on the caster's material
instead of layers (see `shadowCasterMaterial`'s comment in `ThreeBattleRenderer.ts`).

Milestones 3 (world-space fog/particles) and 4 (bloom/post-processing) remain only sketched at
the level the user originally specified them — no design work done yet.

## Goal (user's explicit directive — do not drift from this)

Ember Ashes stays a 2D tactical RPG in gameplay and artwork. Three.js is being introduced
**only** as the battlefield rendering layer. Milestone 1 (terrain + decorations + units + camera
+ mouse interaction, matching the existing Canvas2D-shim renderer exactly) is done and confirmed
by the user — see "Where Milestone 1 left things" below. Milestone 2 is real
`DirectionalLight`/shadows built against that world-space scene. Do not rewrite gameplay systems
(combat, pathfinding, AI, hex math, editor data) — this is a rendering-layer swap only.

## Old atmosphere system — still unwired, do not re-enable

`src/game/gfx/AtmosphereRenderer.ts`, `atmosphereShaders.ts`, `atmosphereParams.ts` are a
fullscreen-2D-overlay global lighting system (ambient wash, drifting light field, procedural
haze, volumetric shafts, dust, bloom, grading) from before the Three.js migration decision. The
user rejected the overlay approach on visual grounds ("does not convincingly occupy the game
world... flat image with a moving filter over it"); it later got built and shipped anyway as
`AtmosphereFX`, then reported to break the game badly enough in play that every reference to it
was stripped back out (the `atmosphereFxOn` HUD toggle, its Options-menu button, and the
point-light shader plumbing in `WebGL2DRenderer`/`EffectsRenderer` that fed it). The three files
are kept in the tree on purpose, unreferenced — **the user does not want them deleted, just never
wired back in.** Milestone 2's real lighting is the intended replacement for what that system was
trying (and failing) to fake — do not resurrect the overlay approach instead of finishing this.

## Where Milestone 1 left things

`src/game/gfx/three/ThreeBattleRenderer.ts` replaces the ground/terrain canvas AND now draws
animated unit sprites too (walk/attack/cast/counter poses, live idle motion, correct fade
opacity) — full parity with the Canvas2D-shim renderer it's meant to replace. Now the default
renderer (see `useThreeGroundRenderer()` in `src/game/BattleCanvas.tsx`); append `?renderer=legacy`
to the app URL to fall back to the original `WebGL2DRenderer` path for comparison. HP bars,
hover/selection hex outline, portal FX, and "front"-layer decorations
still render on the old Canvas2D-shim `unitsCanvas`, stacked above the Three.js canvas — that's
deliberate, not a gap (see `BattleEngine.renderUnitsAndOverlays`' `skipGroundDecor`/
`skipUnitSprites` params).

Full detail on how Milestone 1 was built is in git history (`git log --oneline -- src/game/gfx/three/`
and `src/game/engine.ts`'s `computeUnitVisual`/`unitVisual`/`unitAnchor` methods) — the two
commits that matter most are "Add Three.js battlefield renderer (Milestone 1: terrain +
decorations)" and "Complete Three.js Milestone 1: animated units with correct anchoring and
fade". All three gates (`npm run typecheck && npm run build && npm run test`) passed clean as of
both.

## The critical gotchas already found — do not reintroduce them

**Dev Controls (v0.323): a custom `ShaderMaterial` decal silently drew nothing in this renderer.**
Contact shadows were first built as a ShaderMaterial computing a radial falloff from UV; the meshes
were confirmed visible, in-frustum and at opacity 1 (even at 3x size) yet nothing rendered, while a
plain `MeshBasicMaterial` on the same meshes did. Root cause not chased — switched to the same
CanvasTexture-gradient + `MeshBasicMaterial` technique `activeTurnShadowCatcher` already uses
(see `makeContactShadowTexture`). Also note: `BattleCanvas` hides the Three unit sprites
(`setSpritesAndDecorationsVisible(false, true)` — units draw on the Canvas2D top layer), so never
tie ground-level unit effects to `unitGroup`'s visibility. The toggles themselves live in
`gfx/three/devGfx.ts` (localStorage `emberash:devGfx`), read by the renderer every frame.

**MILESTONE 2: shadow-casters can't be hidden from the main pass with layers, in this Three.js
version.** The obvious way to have an object cast a shadow without ever being drawn is to put it
on a layer only the light's `shadow.camera` enables. That does **not** work here — read
`node_modules/three/src/renderers/webgl/WebGLShadowMap.js`'s `renderObject` function yourself if
in doubt: the per-object `object.layers.test(camera.layers)` check uses the `camera` argument
threaded through from `this.render(lights, scene, camera)`, which is the **main viewing camera**
passed to `renderer.render()`, not the light's own shadow camera — so `shadow.camera.layers` is
never consulted for this at all. A caster on an exclusive layer just silently never casts,
regardless of light intensity (cost a good while to find, since raising intensity to absurd
levels still produced nothing — the mechanism looked broken, not just excluded). The actual fix,
in place now: give the caster's material `colorWrite: false, depthWrite: false` instead (mesh
stays `visible: true`, required — `WebGLShadowMap` skips `object.visible === false` outright).
This writes nothing to the main color or depth buffer, while the shadow pass — which builds its
own separate `MeshDepthMaterial` per object and never reads `colorWrite`/`depthWrite` from the
source material — still renders it normally. See `shadowCasterMaterial`'s comment in
`ThreeBattleRenderer.ts`.

**An orthographic camera with an inverted frustum (`top < bottom`) renders NOTHING in this
Three.js version (0.186)** — confirmed empirically with isolated Playwright tests: identical
scene/camera/mesh renders correctly with a standard frustum (`top > bottom`) and renders nothing
with an inverted one, regardless of camera or mesh position. The natural instinct — invert the
frustum to get "world Y increases downward the screen" matching `BattleEngine`'s `cx/cy`
convention — silently produces a blank canvas.

The fix already in place: keep the frustum standard (`top = cssH, bottom = 0`), and instead
negate Y everywhere in `ThreeBattleRenderer` — mesh `position.y = -wy`, camera
`position.y = -camY - cssH`. This was verified NUMERICALLY (not just visually) against
`BattleEngine`'s own `cx = worldX - camX` / `cy = worldY - camY` formula before being trusted —
see the long comment block at the top of `ThreeBattleRenderer.ts` for the full derivation.
Knock-on effects of this Y-negation, already handled, to remember if you add more geometry:

- Texture `flipY` should stay at its Three.js **default (`true`)** — do NOT set `flipY = false`.
- Any `rotation.z` on a mesh needs its **sign negated** (`-rot * Math.PI / 3`, not `+`) to match
  `ctx.rotate()`'s on-screen clockwise-positive convention — see `ensureBuilt`/`syncDirtyTiles`.
- Custom geometry winding order needs checking: a naive fan-triangulation came out
  back-facing/culled under this camera setup — see `buildHexGeometry`'s comment on the
  `(0, i%6+1, i)` index order.

## The architectural tension Milestone 2 has to resolve — read before writing any code

The entire Milestone 1 scene is **flat**: every tile mesh, decoration quad, and unit sprite quad
lies in the same camera-facing plane, with surface normal `(0, 0, 1)` for all of them. Z is used
*only* to control draw order (tiles at z=0, decor at z=1, units at `2 + row*0.001`) — it does not
represent real spatial depth or height. The orthographic camera looks straight down the Z axis at
this flat arrangement, which is exactly what made Milestone 1's pixel-for-pixel parity with the
Canvas2D renderer possible.

A `THREE.DirectionalLight` computes brightness from the dot product of light direction and
surface normal. Since every mesh here shares the same normal, real Three.js lighting on this
scene as-built would apply one **uniform** tint across everything — no per-object shading, and
critically, **no meaningful cast shadows**: a real shadow needs the caster to have actual spatial
separation from the receiver along the light's direction, and right now "up" (a unit standing on
the ground) isn't a real axis distinct from "north on the screen" (which is already what
Milestone 1's X/Y ground plane encodes).

**The user was asked to choose between two scopes for Milestone 2 and picked the bigger one:**
real cast shadows via an actual elevation axis, not just a `DirectionalLight`+`AmbientLight`
uniform tint. That means some version of reinterpreting the scene so units/decorations have a
real height *above* the ground plane that a light can throw a shadow from — **not** literally
rotating the whole game into an isometric/3D camera (that would break pixel-for-pixel parity with
the Canvas2D renderer and the "stays 2D in gameplay and artwork" directive). The camera view
itself should very likely stay exactly as Milestone 1 built it — the same orthographic, straight
down -Z, matching `BattleEngine`'s screen-pixel math exactly — so mouse interaction, sprite
positioning, and the game's on-screen look don't change at all. What needs to change is *only*
what an invisible shadow-casting light sees.

**A concrete direction worth trying first (unverified — the next session needs to prototype and
check it actually looks right, not assume it does):** keep every visible mesh's position and
camera exactly as Milestone 1 already computes them (so the rendered picture is pixel-identical
to today, sprite billboards included), but give the *shadow-casting* light a separate, real
elevation value per unit/decoration — e.g., a synthetic "height above ground" derived from each
sprite's own drawn height (`v.h` from `BattleEngine.unitVisual`, or `decorSize()`'s `h` for
decorations) — and position an actual `THREE.DirectionalLight` + its shadow camera so the
resulting shadow projects back onto the ground plane in the same direction the existing fake
Canvas2D ellipse shadow already uses (`shadowDirX = 0.6, shadowDirY = 0.8`, see
`renderUnitsAndOverlays`'s shadow-drawing block) — so a real shadow replaces the fake one without
the sun's on-screen angle visibly changing. This likely means each unit/decoration needs a
**second, invisible mesh** (a simple vertical quad or box, positioned using the real elevation
idea) purely for `castShadow` — the visible billboard mesh stays `castShadow = false` since its
own flat orientation relative to the light wouldn't project a sensible shape. Terrain tiles get
`receiveShadow = true`. This is a hypothesis to prototype and visually verify (headless
Playwright, see testing section) before committing to it, not a spec to implement blindly.

Also worth deciding early, before writing shadow code: an `AmbientLight` (or `HemisphereLight`)
alongside the `DirectionalLight` is very likely needed regardless of the shadow approach — a
scene lit by only one directional light makes every unlit surface fully black, which would look
far worse than today's flat unlit rendering. Tune conservatively; the `AtmosphereFX` failure was
partly a "too much, too intrusive" visual problem, not just a technical one — go subtle first and
confirm with the user before pushing intensity up.

**Milestone 2 gating**: don't start Milestone 3 until this is done and verified the same way
Milestone 1 was — real shadows visible and correct via headless-Playwright pixel sampling, all
three gate commands passing, and the user's own sign-off after checking it in their own browser
(never yours — see the testing section below).

## Milestone 3 (planned, not yet designed): world-space fog and particles

Per the original goal directive: once Milestone 2's real lights/shadows exist against real
world-space geometry, Milestone 3 replaces any fog/particle effects that were previously
simulated as fullscreen 2D overlays (the same category of hack `AtmosphereFX`/`AtmosphereRenderer`
represent — see "Old atmosphere system" above) with actual Three.js fog (`THREE.Fog`/
`THREE.FogExp2`) and particle systems placed in real 3D space, so they can interact correctly
with the camera, the terrain, and (after Milestone 2) real lighting — e.g., fog thickening with
distance, particles catching directional light, rather than a flat filter drawn over everything
regardless of what's underneath. No further design has been done on this — the next session to
pick it up should re-confirm scope with the user before starting, the same way Milestone 2's
scope was confirmed here, since "fog" and "particles" are exactly the vocabulary the rejected
`AtmosphereFX` system also used and the user will be watching closely for it to not repeat that
outcome.

## Milestone 4 (planned, not yet designed): bloom and post-processing

Per the original goal directive: the last planned milestone, built once Milestones 2 and 3 give
the scene real lights and real world-space atmosphere for a post-processing pass to have
something honest to work from — bloom on bright/lit surfaces, final color grading, using Three.js's
own post-processing pipeline (`EffectComposer` and passes from `three/examples/jsm/postprocessing/`)
rather than a hand-rolled WebGL2 pass. No design work has been done on this either. Same caution
as Milestone 3: confirm scope with the user before starting, and keep intensity conservative —
this is the same "bloom, final grading" vocabulary the rejected `AtmosphereFX` system used.

## Testing — do not use the live browser

See the saved memory (`feedback_no_live_browser` in the memory system) — the user was explicit
and heated about this ("this is the last time you ever use my browser," "the browser does not
serve you as game testing tool," "the user will do it himself not I"). Always verify with a
throwaway headless Playwright script instead — the script must live under the project root (or
be copied there before running) so Node resolves the `playwright` package from its
`node_modules`; running it from an outside scratch directory fails with `ERR_MODULE_NOT_FOUND`.

Two patterns have worked so far, pick whichever fits what's being checked:

1. **Hand-built engine**: `page.evaluate()` importing `/src/game/assets.ts`,
   `/src/game/engine.ts`, `/src/game/data.ts`, and `/src/game/gfx/three/ThreeBattleRenderer.ts`
   directly, constructing a minimal `BattleEngine` + mission by hand, a detached `<canvas>`,
   calling `.render()` a few times, then either `elementHandle.screenshot()` to a PNG and reading
   it, or sampling pixels via `getImageData` for numeric assertions. More precise for numeric
   checks (e.g. "is this pixel actually darker where a shadow should fall"), more setup.
2. **Drive the real UI**: navigate to `http://127.0.0.1:8080/` (Three is now default;
   `?renderer=legacy` for the Canvas2D path to compare against), click through `Modo teste` (bottom-left
   corner of the title screen) → `Debug` → `Classic Tactical` → click a mission pin with combat
   (the Inn pin has no `Entrar em combate` button — pick a different one, e.g. `Wisp Forest`) →
   `Entrar em combate`, wait ~2.5s for the battle to mount, then screenshot.

Delete throwaway debug scripts/screenshots from the repo root after use — don't leave them
committed.

The dev server should already be running on `http://127.0.0.1:8080/` (`npm run dev`, per
`AGENTS.md`/`startup.sh` conventions) — check with `curl -s -o /dev/null -w "%{http_code}" ...`
before assuming a script needs to start one itself. Note: `vite.config.ts` reads
`package.json`'s version into `__APP_VERSION__` once at server startup — bumping the version
number won't show up in an already-running dev server until it's restarted; that's expected, not
a bug, if you ever see a stale version number on the title screen.

## Gate before calling anything done

`npm run typecheck && npm run build && npm run test` — all three must pass clean.
