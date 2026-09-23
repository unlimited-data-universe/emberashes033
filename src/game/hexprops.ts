/**
 * Consolidated hex properties: the base terrain with the decoration layer folded on
 * top, resolved when a rule asks rather than by rewriting the board.
 *
 * A placed decoration can carry `blocksPath` and `yieldsHighGround` (see
 * DecorationPlacement). Those are read here and nowhere else: `hexDef` is what the
 * rules call instead of `TERRAIN[tileAt(...)]`, so movement, line of sight, the
 * high-ground combat bonus, ranged reach and the HUD all see one consolidated answer.
 *
 * Nothing writes to `tiles`. The painted terrain stays exactly as the author left it,
 * which is why deleting a decoration needs no undo pass and why "impassable and
 * elevated" needs no terrain of its own — it is a combination this function returns,
 * not a tile that has to exist.
 *
 * Both flags are additive, matching the consolidation they were specified with: a
 * flag that is off contributes nothing and the hex keeps the base terrain's own
 * answer, and a flag that is on can only add. Neither can make a barricade walkable
 * or take height off a hill.
 */
import { BIG_HOUSE_DECOR_IDS, CHEST_DECOR_IDS, HOUSE_DECOR_IDS, TERRAIN, WEAPONS } from "./data.ts";
import type { DecorationPlacement, TerrainDef, TerrainId, Unit } from "./types.ts";

export const HEX_BLOCKED = 1;
export const HEX_HIGH = 2;

/**
 * One byte per cell, row-major like `tiles`, holding the two flags the decorations on
 * that cell contribute.
 *
 * A byte array rather than a keyed map because `terrainDistanceField` walks every cell
 * of the board six times over and `footprintCost` runs in the movement inner loop —
 * both already index by `y * cols + x`, so a lookup here costs an array read and no
 * string.
 */
export type DecorOverlay = Uint8Array;

export const EMPTY_OVERLAY: DecorOverlay = new Uint8Array(0);

/**
 * Fold every placement's switches into a per-cell overlay. Call it when the decoration
 * list changes, not per query.
 *
 * `cellsOf` is injected because expanding a rotated footprint lives in ./data, which
 * imports this module's neighbour — passing it in keeps the dependency one-way and
 * keeps this file testable without the decoration table.
 */
export function buildDecorOverlay(
  decorations: readonly DecorationPlacement[],
  cols: number,
  rows: number,
  cellsOf: (p: DecorationPlacement) => { dx: number; dy: number }[],
): DecorOverlay {
  const overlay = new Uint8Array(cols * rows);
  for (const p of decorations) {
    // A house is a real building — nothing should be able to walk through one, whether or
    // not the map author remembered to check "Bloquear caminho" for this particular
    // placement. Folded in here (not just defaulted at editor placement time, the way
    // BARRICADE_LIKE_DECOR is) so it also covers every house already placed on an existing
    // map, not only new placements going forward.
    const isHouse = HOUSE_DECOR_IDS.has(p.id) || BIG_HOUSE_DECOR_IDS.has(p.id);
    // A locked chest is solid until picked, same as a house — folded in here rather than
    // stamping "chest" terrain under it (see DECORATIONS.locked-chest's own comment), so
    // the real floor stays untouched and every existing placement is covered for free.
    const isChest = CHEST_DECOR_IDS.has(p.id);
    const bits = (p.blocksPath || isHouse || isChest ? HEX_BLOCKED : 0) | (p.yieldsHighGround ? HEX_HIGH : 0);
    if (!bits) continue;
    for (const { dx, dy } of cellsOf(p)) {
      const x = p.x + dx;
      const y = p.y + dy;
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      overlay[y * cols + x]! |= bits;
    }
  }
  return overlay;
}

/**
 * Derived terrain defs, one per (base terrain, flags) pair actually used.
 *
 * `hexDef` sits in the movement and line-of-sight inner loops, so it must not mint an
 * object per call. There are at most three flag combinations per terrain, so the whole
 * cache is tiny and settles after the first few queries.
 */
const derived = new Map<string, TerrainDef>();

function deriveDef(base: TerrainDef, bits: number): TerrainDef {
  const cacheKey = `${base.id}|${bits}`;
  const hit = derived.get(cacheKey);
  if (hit) return hit;
  const out: TerrainDef = { ...base };
  if (bits & HEX_BLOCKED) {
    out.passable = false;
    out.moveCost = 99;
    // Solidity is one thing in this engine: a prop that stops a step also stops an
    // arrow and blocks sight. Keeping those together is what "solid is solid" meant.
    out.blocksShot = true;
  }
  if (bits & HEX_HIGH) {
    out.height = 1;
    // The same numbers hill/highwood/highruin carry, so a prop granting high ground
    // grants exactly what standing on a hill grants — not a second scale of bonus.
    out.atk = Math.max(base.atk, 2);
    out.def = Math.max(base.def, 1);
    if (out.passable) out.moveCost = Math.max(base.moveCost, 2);
  }
  derived.set(cacheKey, out);
  return out;
}

/**
 * The properties of one hex: base terrain, plus whatever decoration sits on it.
 *
 * Returns the shared `TERRAIN` entry untouched when no decoration overrides the cell,
 * which is the overwhelmingly common case and costs one array read to establish.
 */
export function hexDef(
  tiles: TerrainId[],
  cols: number,
  x: number,
  y: number,
  overlay: DecorOverlay = EMPTY_OVERLAY,
): TerrainDef {
  // The same read as `tileAt` in ./pathfinding, inlined rather than imported: that
  // module reads its rules from this one, and importing back would make the pair
  // circular. This is the lowest layer, so it depends on nothing but the table.
  const base = TERRAIN[tiles[y * cols + x] ?? "plains"];
  if (overlay.length === 0) return base;
  const bits = overlay[y * cols + x] ?? 0;
  return bits === 0 ? base : deriveDef(base, bits);
}

/**
 * A shooter's reach from one hex, with the high-ground bonus taken from the
 * consolidated properties.
 *
 * `effectiveMaxRange` in ./data answers the same question from a bare TerrainId, which
 * cannot see a decoration's `yieldsHighGround`. This is the version rules should use
 * where a cell is known; the other stays for the HUD readouts that only have a tile.
 */
export function effectiveMaxRangeAt(
  unit: Pick<Unit, "maxRange" | "weaponId">,
  tiles: TerrainId[],
  cols: number,
  x: number,
  y: number,
  overlay: DecorOverlay = EMPTY_OVERLAY,
): number {
  const high = hexDef(tiles, cols, x, y, overlay).height ? 1 : 0;
  const ranged = unit.weaponId ? !!WEAPONS[unit.weaponId]?.ranged : false;
  return unit.maxRange + (ranged ? high : 0);
}

/**
 * The two consolidated answers on their own, for callers that want the decision rather
 * than a whole terrain def.
 */
export function hexProps(
  tiles: TerrainId[],
  cols: number,
  x: number,
  y: number,
  overlay: DecorOverlay = EMPTY_OVERLAY,
): { blocked: boolean; highGround: boolean } {
  const d = hexDef(tiles, cols, x, y, overlay);
  return { blocked: !d.passable, highGround: !!d.height };
}
