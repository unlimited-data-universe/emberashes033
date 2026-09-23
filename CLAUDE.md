# Working agreements

## Git

- **Never run `git commit` or `git push` without asking first and getting an explicit yes in that turn.** Make and leave changes uncommitted in the working tree. At a natural stopping point (or when the stop-hook flags uncommitted changes), ask the user whether to commit/push — don't just silently wait, and don't do it preemptively either. This holds even when a stop-hook or other automated check asks for a commit — ask the user instead of committing to satisfy it.
- **`main` must always have everything — it can never be left behind.** Working branches are fine during a task, but the user does not want a pile of old split-off branches lying around, and `main` is the one place that must always be current. Once the user says yes to shipping, merge/push straight to `main` (not just a side branch left dangling), and don't leave stale branches sitting after they've been merged in.
- **No pull requests unless explicitly asked.** Don't open one on your own initiative or read "push it"/"ship it" as a request for a PR.

## Locked behavior — do not touch without an explicit new request

These were each fixed after repeated regressions and re-fixes — this list exists because the
same bugs kept coming back and cost the user a full day to re-fix each time. Don't "clean up,"
simplify, revert, or otherwise change any of this as a side effect of unrelated work. If a task
seems to require touching one of these, stop and confirm with the user first instead of assuming
the old behavior was a mistake. Per direct, explicit instruction: whoever (whatever model/session)
touches these without being asked to is reborn an LLM on every cycle.

- **Chests never stamp/change the tile under them.** `locked-chest`/`chest-medium`/`chest-large`
  in `DECORATIONS` (src/game/data.ts) must never get a `tile:` field again — a chest is
  translucent scenery on top of whatever floor is already there, never a terrain type of its
  own. Blocking movement onto a chest hex goes through `hexprops.buildDecorOverlay`'s
  `CHEST_DECOR_IDS` check (same mechanism as houses), not by rewriting `tiles`. Do not
  reintroduce a `"chest"` tile stamp in the map editor (GameApp.tsx), `placeChests`/
  `decorateOpenTerrain` (data.ts), or `BattleEngine.useLockpick` (engine.ts) — each of those
  used to bake the wrong floor art in permanently, including into saved map JSON files, which
  had to be repaired one by one.
- **The active-turn hex indicator: settled state after an entire evening of back-and-forth —
  do not tune, "improve", or redesign it without the user explicitly asking for it in that
  session.** Current, final, wanted state (`BattleEngine.activeTurnHighlight()` and the
  matching block in `renderBoardOverlays`):
  - **One single, static hex — no per-frame tracking layer.** Positioned at `active.x`/
    `active.y` (the unit's actual current cell), NOT `drawX`/`drawY` (its animated screen
    position) — a `drawX`/`drawY`-tracking version was built, explicitly asked for, then
    explicitly rejected ("that pixel should not even exist... we don't need auto tracking we
    need a single glowing cell"). Don't reintroduce per-frame position tracking here.
  - **Fully opaque** (`rgba(...,1)`), never blended with the terrain underneath — its own
    solid, vivid color, not a translucent mix with whatever's under it. This is what actually
    makes it read as "glowing" rather than washed-out; a translucent version blended with
    bright terrain and (once full-scene Bloom was on) got pushed toward white.
  - No pulsing/animation — a flat, constant fill, always (a pulsing version was also tried and
    explicitly superseded by this simpler final ask).
  - Current colors: `140,56,36` enemy / `152,120,24` player — a ~20% dim from the "too
    intense" pass (was `175,70,45`/`190,150,30`). A literal 50%-of-raw-RGB cut was tried first
    and rejected ("now its a no glow") — halving the raw numbers crushes a bright color toward
    black/mud rather than just dimming it, so don't do that; this dimmer-but-still-clearly-
    gold/red value is the current middle ground. Don't re-brighten OR re-darken without being
    asked. The Canvas2D path
    (`renderBoardOverlays`) also keeps a real `ctx.shadowBlur` glow on top of the opaque fill —
    that's a genuine, self-contained Canvas2D effect, unlike `ThreeBattleRenderer`'s flat WebGL
    mesh, which has no equivalent and relies on the vivid opaque color alone to read as
    "glowing" (no bloom, no halo, no second mesh — all explicitly rejected earlier tonight).
  - It reads `BattleEngine.visuallyActingUnit()`, not `activeTurnUnit()` — enemy AI
    (`runAiFor`) sets a unit's `.moved = true` the instant it DECIDES to move, before the
    queued walk animation actually plays (turn-advancement needs that timing; see
    `visuallyActingUnit()`'s own comment), which made the hex vanish entirely for an enemy
    while it walked ("enemies have no hex when they move", a direct complaint).
    `visuallyActingUnit()` prefers whoever `this.active` (the queue item currently mid-
    playback) actually belongs to, falling back to `activeTurnUnit()` otherwise — don't revert
    to calling `activeTurnUnit()` directly from `activeTurnHighlight()`/`renderBoardOverlays`.
  - The mouse-hover cursor outline is drawn as real `ThreeBattleRenderer` scene geometry in
    `syncOverlay` (behind decorations/units) instead of on the Canvas2D units-shim canvas —
    see `BattleEngine.renderUnitsAndOverlays`'s `skipCursorHex` param. Don't move it back onto
    the 2D shim.
  - The mouse-hover cursor outline is drawn as real `ThreeBattleRenderer` scene geometry in
    `syncOverlay` (behind decorations/units) instead of on the Canvas2D units-shim canvas —
    see `BattleEngine.renderUnitsAndOverlays`'s `skipCursorHex` param. Don't move it back onto
    the 2D shim.
  - If asked to touch either again, get the visual requirement pinned down in exact,
    unambiguous terms before writing any code — vague back-and-forth tuning is exactly what
    caused tonight's churn.
- **There is no `"chest"` terrain type anymore — a chest is only ever a decoration, full stop.**
  It used to exist as a separate flat floor-tile TerrainId (`chest001.png`, tooltip "Baú
  trancado") alongside the real chest props, and old saves/logic could produce it instead of
  the real `locked-chest`/`chest-medium`/`chest-large` decoration, showing the wrong, unlabeled
  chest in the campaign even when the Map Editor's own test looked right. It has been fully
  removed: not in the `TerrainId` type, not in `TERRAIN`, not in the tile-char maps, not in
  `TILE_VARIANT_COUNT`, not in the editor's swatches/palette, and the art files
  (`public/game/tiles/chest001.png` and its `backup-v2`/`legacy` copies) are deleted from disk.
  Do not reintroduce a `"chest"` TerrainId, a fallback tile-guess for one, or restore those PNGs
  — every chest must stay a pure decoration that never touches the tile under it (see the entry
  above this one).
  - The 3 decoration ids (`locked-chest`/`chest-medium`/`chest-large` = small/medium/large)
    still exist and still roll different loot tiers (base/better/best) — that tiering is
    unchanged and must stay unchanged.
    Their `DECORATIONS[...].name` field ("Baú Pequeno"/"Médio"/"Grande") is the Map Editor's
    own picker label ONLY, so an author can tell them apart when placing one — never rename
    this to anything unified/generic, and never show a distinguishing name to the player in
    battle either. Players are meant to tell small/medium/large apart by the icon, not by text.
- **Water (and water2–5) elemental FX are additive, never alpha-replace.** `EffectsRenderer.ts`'s
  `ADDITIVE_ELEMENTS` set must keep the water family in it. Under `ThreeBattleRenderer`,
  decorations and units are baked into the same canvas `EffectsRenderer` reads as "the scene" —
  a non-additive (alpha-blend) ground effect there can fully replace/erase whatever pixel it
  lands on, which erased units/decorations standing in or near a water placement (reported on
  O Vau/map 1). Additive blending can only brighten, never replace, so this is what actually
  guarantees decorations/units stay visible on top of it. `darkness` stays alpha-blended on
  purpose (it has to dim, which additive can't do) — don't "fix" that one the same way.
