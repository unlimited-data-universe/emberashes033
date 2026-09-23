import { CHEST_LOOT, EMPTY_BAG, EQUIPMENT, heroRecruited, MAX_LEVEL, partyBagHasRoom, POTION_CARRY_MAX, POTIONS, statsFor, weightedLootPick, weightedPotionPick, WEAPONS, WORLD_LOCATIONS } from "./data";
import { DAILY_HUNGER_COST, drainHunger } from "./hunger";
import { missionsForLocation, RANDOM_ENCOUNTER_REGIONS } from "./mapstore";
import { cubeRound, cubeToOddr, hexNeighbors, key, oddrToCube } from "./pathfinding";
import type { ClassId, Point, SaveData, WorldLocation } from "./types";

/** RPG map only: the hidden hex grid laid over the world-map image. The renderer never
 * draws this — it only ever asks `neighborsOf` the party's current hex for what's
 * clickable, and `hexToWorld` for where to draw a dot. Coordinates are odd-r offset,
 * same convention pathfinding.ts already uses for the battle grid, just a separate and
 * much coarser grid with its own pixel scale. */

/** Hex "radius" in percent of the world-map image's width/height. Chosen so the existing
 * WORLD_LOCATIONS (spread roughly 12-86% x, 9-80% y) land several hex-steps apart, giving
 * travel room instead of every location being a single step from the next. */
const OVERWORLD_HEX_SIZE = 5;

const SQRT3 = Math.sqrt(3);

/** World-map percent coordinate -> nearest hex, via the standard pointy-top axial/pixel
 * conversion (redblobgames), reusing this project's own cube rounding and axial->offset
 * conversion instead of reinventing either. */
export function worldToHex(xPct: number, yPct: number): Point {
  const q = ((SQRT3 / 3) * xPct - (1 / 3) * yPct) / OVERWORLD_HEX_SIZE;
  const r = ((2 / 3) * yPct) / OVERWORLD_HEX_SIZE;
  const c = cubeRound(q, r, -q - r);
  return cubeToOddr(c.q, c.r);
}

/** Inverse of worldToHex — a hex's own pixel center, in the same percent space. */
export function hexToWorld(col: number, row: number): { x: number; y: number } {
  const { q, r } = oddrToCube(col, row);
  const x = OVERWORLD_HEX_SIZE * SQRT3 * (q + r / 2);
  const y = OVERWORLD_HEX_SIZE * 1.5 * r;
  return { x, y };
}

/** One hex west of Stone Bridge; this is also the hard western edge of the map. */
export const OVERWORLD_START_HEX = (() => {
  const stoneBridge = WORLD_LOCATIONS.find((location) => location.id === "stonebridge");
  const bridge = worldToHex(stoneBridge?.x ?? 14, stoneBridge?.y ?? 62);
  return { x: bridge.x - 1, y: bridge.y };
})();

export const OVERWORLD_WEST_EDGE_COL = OVERWORLD_START_HEX.x;

const STONE_BRIDGE_MISSION_IDS = WORLD_LOCATIONS.find((location) => location.id === "stonebridge")?.missionIds ?? [];

/** The opening is deliberately linear: leave the western edge by the east hex, complete
 * the full Stone Bridge mission set, then the full three-way travel choice opens up. Kept in the logic layer so a
 * click or a future renderer cannot bypass the tutorial route. */
export function canStepOverworld(save: SaveData, from: Point, to: Point, test = false): boolean {
  // Modo teste: full freedom to walk anywhere, same as every other test-mode override —
  // testing movement range/random encounters needs the whole grid open, not just the
  // linear tutorial route out of Stone Bridge.
  if (test) return true;
  if (STONE_BRIDGE_MISSION_IDS.every((missionId) => save.completed.includes(missionId))) return true;
  const atStart = from.x === OVERWORLD_START_HEX.x && from.y === OVERWORLD_START_HEX.y;
  // O Vau is fought right at the western edge, before the party has taken a single step —
  // the party has nowhere to walk to yet until it's cleared, so the east move (the only one
  // this edge ever offers) stays closed until save.completed says so.
  return atStart && to.x > from.x && save.completed.includes("vau");
}

/** The only notion of adjacency the RPG map is allowed to use. */
export function neighborsOf(col: number, row: number): Point[] {
  return hexNeighbors(col, row);
}

export function isNeighbor(a: Point, b: Point): boolean {
  return neighborsOf(a.x, a.y).some((n) => n.x === b.x && n.y === b.y);
}

/** Hand-picked cutouts inside the otherwise-rectangular [0,100]x[0,100] bounds — the art's
 * landmass is a ragged silhouette, not a rectangle, so a handful of hexes near its edges
 * land mathematically in-bounds while actually sitting on the blank parchment margin (e.g.
 * the three hexes just past Village to the north, over open sky above the coastline). Add
 * to this set rather than reshaping the bounds check itself, which every other hex still
 * relies on. */
const OVERWORLD_OFF_MAP_HEXES = new Set<string>([
  key(2, 1),
  key(1, 1),
  key(1, 2),
  // Upper-right neighbor of (3,2) (east of the coastline edge hex) — well above the
  // mountain ridge line, same blank-sky margin as the three above.
  key(3, 1),
  // One more step east, same story — still above the ridge near Fortified Temple Complex.
  key(4, 1),
  // Upper-right of (5,2) — sits right on the castle's silhouette edge, over sky rather
  // than roofline.
  key(5, 1),
  // Upper-right of (7,2) — open sky above the mountain ridge east of the castle.
  key(7, 1),
  // Upper-right of (6,2), the Fortified Temple Complex icon's own hex — blank sky right at
  // the citadel's roofline edge.
  key(6, 1),
  // Two steps east of the citadel then one upper-right, at (8,1) — another mountain-ridge
  // edge. Both its upper neighbors (NW and NE) are blank sky above the peak.
  key(8, 0),
  key(9, 0),
  // Direct east of (8,1) — same blank sky above the ridge.
  key(9, 1),
  // From (8,1): SE to (9,2), then east to (10,2) — a thin peninsula tip, another edge.
  // Its upper-right (10,1) is open sky above the ridge; its direct east (11,2) is past the
  // tip, over blank parchment.
  key(10, 1),
  key(11, 2),
  // One hex south of (10,2), at (10,3) near the Ruins — direct east is past the cliff edge,
  // over blank parchment.
  key(11, 3),
  // Rest of column 11, surveyed top to bottom against the art: land only at rows 4
  // (mountain cliff) and 6 (graveyard cliff near the Ruins) — row 10 looked like forest
  // canopy at a glance but is actually mostly blank at its edge, see below. Every other
  // row here is blank parchment past the coastline/cliff edge.
  key(11, 0),
  key(11, 5),
  key(11, 7),
  key(11, 8),
  key(11, 9),
  key(11, 11),
  key(11, 12),
  key(11, 13),
  // Southeast corner of The Verdant Refuge's landmass (around hex (9,11)) — (11,12) above
  // is already covered by the column-11 sweep; these two are the rest of that same blank
  // corner, just past the tree roots' southern edge.
  key(10, 13),
  key(9, 13),
  // (11,10) was marked land in the column-11 sweep but a closer look shows it's mostly
  // over blank parchment, right at the canopy's edge — reclassifying it here.
  key(11, 10),
  // From Verdant Refuge (9,11), two steps southwest: (9,12) is fine (roots), but (8,13)
  // sits right on the boundary between rocky ground and the blank margin below it.
  key(8, 13),
  // Lower-right (SE) neighbor of OVERWORLD_START_HEX (1,8) — off the western landmass edge.
  key(1, 9),
  // Lower-right (SE) neighbor of Stone Bridge (2,8), one step further along the same
  // blank margin below the ford.
  key(2, 9),
  // Traced walking east then SE twice from Stone Bridge: (2,8) -> E -> (3,8) -> SE -> (3,9)
  // -> SE -> (4,10) -> SE -> (4,11). West of (4,10) is (3,10), blank margin. West of (4,11),
  // (3,11), turned out to actually be on the landmass (walkable from Frozen Swamp's west
  // side) — reported and restored rather than left wrongly excluded.
  key(3, 10),
  // Lower-left (SW) and lower-right (SE) neighbors of the Frozen Swamp hex (5,11) — both
  // reported as blank margin south of the swamp.
  key(5, 12),
  key(6, 12),
  // One step east of Frozen Swamp then one more east — (7,11) is blank margin.
  key(7, 11),
  // Lower-right (SE) neighbor of (6,11), directly below the party's current hex.
  key(7, 12),
  // From (6,11), NE to (7,10), then that hex's own E (8,10) is blank margin. Its NE, (7,9),
  // turned out to actually be on the landmass (walkable from (6,9)'s east side) — reported
  // and restored rather than left wrongly excluded.
  key(8, 10),
  // East of the restored (7,9), across the party's actual walked path — blank margin.
  key(8, 9),
  // From the Inn (5,7): 3x E to (8,7), then SE to (9,8) — that hex's own SE, (9,9), is blank
  // margin.
  key(9, 9),
  // One step east of (9,8), at (10,8) — its own SE, (10,9), is blank margin.
  key(10, 9),
  // From Frozen Swamp (5,11): W, SW, SW lands at (3,13) — its own W, (2,13), is blank margin.
  key(2, 13),
  // Upper-left (NW) and upper-right (NE) neighbors of Misty Cave (6,6) — both blank margin.
  key(5, 5),
  key(6, 5),
]);

/** Finite logical board, independent of the map's rendered dimensions and zoom. */
export function isOverworldCell(col: number, row: number): boolean {
  if (!Number.isInteger(col) || !Number.isInteger(row)) return false;
  if (OVERWORLD_OFF_MAP_HEXES.has(key(col, row))) return false;
  const p = hexToWorld(col, row);
  return col >= OVERWORLD_WEST_EDGE_COL && p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100;
}

/** Every named location, keyed by its hex — built from whatever location list the map is
 * currently showing (the editor can move locations, same as the classic map already
 * tolerates), not a fixed snapshot. Anything not in this map is open wild ground. */
export function locationsByHex(locations: WorldLocation[]): Map<string, WorldLocation> {
  const out = new Map<string, WorldLocation>();
  for (const loc of locations) {
    const h = worldToHex(loc.x, loc.y);
    out.set(key(h.x, h.y), loc);
  }
  return out;
}

export function locationAt(locations: WorldLocation[], col: number, row: number): WorldLocation | undefined {
  return locationsByHex(locations).get(key(col, row));
}

/** A location past its (opt-in, currently unset on everything) deadline — purely derived
 * from the day clock, never stored, so it can't drift out of sync with it. */
export function locationExpired(location: WorldLocation, gameClock: number): boolean {
  return typeof location.deadlineDay === "number" && gameClock > location.deadlineDay;
}

/** Flat share of missing HP a unit recovers per day traveled, so long as the party ate
 * that day (see `fed` in stepOverworld). */
const RECOVERY_PCT = 0.08;
/** Chance a step onto open wild ground (no location) triggers a real battle, pulled from
 * the "road" random-encounter region — the only region mapped to actual overworld travel
 * so far (see RANDOM_ENCOUNTER_REGIONS in mapstore.ts). Checked before the flavor-text
 * roll below, so the two can never both fire on the same step. */
const BATTLE_ENCOUNTER_CHANCE = 0.15;
/** Chance a step onto open wild ground (no location, and no battle rolled above) triggers
 * a text-only flavor encounter. */
const TEXT_ENCOUNTER_CHANCE = 0.25;
/** Every actual day on the road carries a small illness risk for one healthy travelling hero. */
const TRAVEL_DISEASE_CHANCE = 0.02;
/** Consecutive unfed days before Hungry actually kicks in — the grace period named in
 * the spec ("após 3 dias sem comida"). */
const HUNGER_GRACE_DAYS = 3;
/** Stat penalty added per day past the grace period, capped below. */
const HUNGER_PENALTY_PER_DAY = 0.1;
/** Cap on the hunger penalty — "chegando em 90% ele fica inconsciente." Exported so the
 * battle engine can bench a hero outright at this threshold (see BattleEngine's
 * playerSpawns filter) instead of just docking their stats like every lesser tier. */
export const HUNGER_PENALTY_MAX = 0.9;

const HERO_BASE_CLASS: Record<string, ClassId> = {
  Kael: "swordsman",
  Neera: "archer",
  Voss: "mage",
  Salazar: "healer",
  // Join later in the story (and only playable early via test mode) but once recruited
  // they're full party members — same daily hunger drain/recovery as everyone else, not a
  // silent exemption because this map predates them.
  Aldric: "aldric",
  Malrec: "conjurer",
};

/** Whether every hero who actually ages (test mode: everyone shown; real campaign: only
 * recruited, living heroes — same gate stepOverworld's own drain uses) currently has any
 * fullness left. Exported so a ration action outside of stepping (Alimentar todos, Inn)
 * can clear hungerStreak the moment it's earned instead of waiting for the next step. */
export function partyIsFed(save: SaveData, test = false): boolean {
  const ages = (hero: string) => test || (heroRecruited(hero, save.completed) && (save.unitHp[hero] ?? maxHpFor(save, hero)) > 0);
  return Object.keys(HERO_BASE_CLASS).filter(ages).every((hero) => (save.heroHunger[hero] ?? 100) > 0);
}

function maxHpFor(save: SaveData, hero: string): number {
  const classId = (save.promotions[hero] as ClassId | undefined) ?? HERO_BASE_CLASS[hero];
  if (!classId) return 0;
  return statsFor(classId, save.levels[hero] ?? 1).hp;
}

/** The party's current hunger stat penalty (0..0.9), purely derived from hungerStreak —
 * same principle as locationExpired: never cached, so it can't drift out of sync with
 * the streak that drives it. Shared by the battle roster builder and the status-sheet
 * condition text so neither can compute a different number than the other. */
export function hungerPenaltyFor(hungerStreak: number): number {
  const daysPast = Math.max(0, hungerStreak - HUNGER_GRACE_DAYS);
  return Math.min(HUNGER_PENALTY_MAX, daysPast * HUNGER_PENALTY_PER_DAY);
}

export interface OverworldEvent {
  kind: "encounter" | "hungry" | "battle";
  text: string;
  /** Set only when kind is "battle" — the random-encounter Mission.id to launch. */
  missionId?: string;
}

/** Every encounter id assigned to the "road" region in random-encounters.json — the only
 * region wired to real overworld travel so far (see BATTLE_ENCOUNTER_CHANCE above). */
function roadEncounterIds(): string[] {
  return RANDOM_ENCOUNTER_REGIONS.find((region) => region.id === "road")?.encounterIds ?? [];
}

const ENCOUNTERS: { text: string; rationsDice?: number; ember?: number; goldLossDice?: number; lootBag?: boolean; losePotion?: boolean; loseLockpick?: boolean; diseaseChance?: number; alertDays?: number }[] = [
  // Rations lost are rolled (1d8), not fixed, and folded into the text shown to the
  // player — see the rationsLost formatting in stepOverworld.
  { text: "Um bando de corvos assusta a coluna e parte das rações se perde na correria.", rationsDice: 8 },
  // Rolled like a regular small chest (see CHEST_LOOT) rather than a flat Ember number —
  // see the lootBag branch in stepOverworld.
  { text: "Vestígios de um acampamento abandonado — e uma bolsa esquecida.", lootBag: true },
  // Independent of the generic per-day travel disease roll (see TRAVEL_DISEASE_CHANCE
  // above) — getting drenched is its own, separate chance to fall sick, not a bigger
  // multiplier on the everyday one.
  { text: "Chuva forte atrasa a marcha, mas ninguém se machuca.", diseaseChance: 0.05 },
  // Real resolution, not just atmosphere: whatever left these tracks is still out there —
  // doubles BATTLE_ENCOUNTER_CHANCE for the next 3 travel days (see alertStreak/stepOverworld).
  { text: "Pegadas grandes demais cruzam o caminho. O grupo segue mais alerta.", alertDays: 3 },
  { text: "Uma carroça atolada cede de vez; comida e mantimentos caem no barro.", rationsDice: 4 },
  { text: "Um frasco se solta durante a descida e se quebra nas pedras.", losePotion: true },
  { text: "Ladrões passam pelo acampamento durante a noite e levam uma gazua.", loseLockpick: true },
  { text: "A ponte podre arrebenta sob a carga: parte do ouro e das rações vai para o rio.", rationsDice: 3, goldLossDice: 8 },
];

/** Modo teste only: jumps straight to any hex, no adjacency check, no day/ration/HP cost.
 * Testing needs to reach any location on demand — walking it out one step at a time isn't
 * a real constraint there, it's just friction. */
export function teleportOverworld(save: SaveData, col: number, row: number): SaveData {
  return { ...save, overworldPos: { col, row } };
}

/** Advances the RPG map by exactly one hex step, always exactly one day. Refuses (returns
 * the save unchanged, no event) if the target hex isn't actually a neighbor of the current
 * position — the UI is expected to only ever offer neighbors, but this is the one place
 * that enforces it regardless. */
export function stepOverworld(save: SaveData, toCol: number, toRow: number, locations: WorldLocation[], test = false): { save: SaveData; event: OverworldEvent | null } {
  const from = { x: save.overworldPos.col, y: save.overworldPos.row };
  const to = { x: toCol, y: toRow };
  if (!isOverworldCell(toCol, toRow) || !isNeighbor(from, to) || !canStepOverworld(save, from, to, test)) return { save, event: null };

  const heroHunger = { ...save.heroHunger };
  // Modo teste: everyone shown in the party feels the same daily drain, full stop — not
  // gated on heroRecruited OR on unitHp (a hero who never formally joined this save, or
  // whose HP record is stale/zeroed from before they were recruited, still ages). Same
  // god-mode rule this whole file already follows for canStepOverworld. A real campaign
  // still gates on both, same as ever.
  const ages = (hero: string) => test || (heroRecruited(hero, save.completed) && (save.unitHp[hero] ?? maxHpFor(save, hero)) > 0);
  for (const hero of Object.keys(HERO_BASE_CLASS)) {
    if (ages(hero)) heroHunger[hero] = drainHunger(heroHunger[hero], DAILY_HUNGER_COST);
  }

  const fed = Object.keys(HERO_BASE_CLASS).filter(ages).every((hero) => (heroHunger[hero] ?? 100) > 0);
  const rations = save.rations;
  const prevPenalty = hungerPenaltyFor(save.hungerStreak);
  const hungerStreak = fed ? 0 : save.hungerStreak + 1;

  const unitHp: Record<string, number> = { ...save.unitHp };
  // Recovery only happens on a day the party actually ate — "não ativa a recuperação de
  // HP durante a exploração do mapa" whenever there's nothing to eat. Hunger itself never
  // does direct HP damage; it only docks combat stats (see hungerPenaltyFor), applied at
  // battle spawn, not here.
  if (fed) {
    for (const hero of Object.keys(HERO_BASE_CLASS)) {
      const max = maxHpFor(save, hero);
      if (max <= 0) continue;
      const current = unitHp[hero] ?? max;
      if (current <= 0 || current >= max) continue; // fallen heroes don't heal on the road
      unitHp[hero] = Math.min(max, Math.round(current + max * RECOVERY_PCT));
    }
  }

  let event: OverworldEvent | null = null;
  const newPenalty = hungerPenaltyFor(hungerStreak);
  if (newPenalty > prevPenalty) {
    event =
      newPenalty >= HUNGER_PENALTY_MAX
        ? { kind: "hungry", text: "O grupo desmaia de fome. Preciso retornar a uma estalagem." }
        : { kind: "hungry", text: `Fome: o grupo já passa ${hungerStreak} dias sem comer (−${Math.round(newPenalty * 100)}% nos atributos).` };
  }

  let rationsDelta = 0;
  let emberDelta = 0;
  let weapons = save.weapons;
  let looseEquipment = save.looseEquipment;
  let bags = save.bags;
  const heroDiseases = { ...save.heroDiseases };
  const healthyTravellers = Object.keys(HERO_BASE_CLASS).filter((hero) => ages(hero) && !heroDiseases[hero]);
  let diseaseText = "";
  // This roll happens for every completed travel day, independent of whether the day also
  // produces a battle or text encounter. Once sick, a hero is skipped until cured.
  if (healthyTravellers.length > 0 && Math.random() < TRAVEL_DISEASE_CHANCE) {
    const hero = healthyTravellers[Math.floor(Math.random() * healthyTravellers.length)]!;
    heroDiseases[hero] = true;
    diseaseText = `${hero} contraiu uma doença na estrada (−10% nos atributos até ser curado).`;
  }
  const landedLocation = locationAt(locations, toCol, toRow);
  const roadIds = roadEncounterIds();
  // Doubled, not just flat-boosted, while the "large tracks" alert is active — same relative
  // read on the odds regardless of what BATTLE_ENCOUNTER_CHANCE itself is tuned to later.
  const battleChance = save.alertStreak > 0 ? BATTLE_ENCOUNTER_CHANCE * 2 : BATTLE_ENCOUNTER_CHANCE;
  let alertStreak = Math.max(0, save.alertStreak - 1);
  let lastRoadEncounterId = save.lastRoadEncounterId;
  if (!event && !landedLocation && roadIds.length > 0 && Math.random() < battleChance) {
    // Never the same road encounter twice in a row — drop last time's pick from the pool
    // unless it's the only one there is, in which case a repeat is unavoidable.
    const pool = roadIds.length > 1 ? roadIds.filter((id) => id !== save.lastRoadEncounterId) : roadIds;
    const missionId = pool[Math.floor(Math.random() * pool.length)]!;
    lastRoadEncounterId = missionId;
    event = { kind: "battle", text: "", missionId };
  }
  if (!event && !landedLocation && Math.random() < TEXT_ENCOUNTER_CHANCE) {
    const pick = ENCOUNTERS[Math.floor(Math.random() * ENCOUNTERS.length)]!;
    if (pick.diseaseChance && Math.random() < pick.diseaseChance) {
      const stillHealthy = Object.keys(HERO_BASE_CLASS).filter((hero) => ages(hero) && !heroDiseases[hero]);
      if (stillHealthy.length > 0) {
        const hero = stillHealthy[Math.floor(Math.random() * stillHealthy.length)]!;
        heroDiseases[hero] = true;
        const text = `${hero} pegou um resfriado na chuva (−10% nos atributos até ser curado).`;
        diseaseText = diseaseText ? `${diseaseText} ${text}` : text;
      }
    }
    if (pick.lootBag) {
      // Same odds/shape as a regular small chest (see BattleEngine.useLockpick and
      // CHEST_LOOT): guaranteed Ember, a guaranteed weighted potion, and two independent
      // rolls for a piece of gear and a rations bonus. Applied straight to SaveData since
      // there's no live battle unit to hand the potion to or a chest tile to open.
      const gain = CHEST_LOOT.emberBase + Math.floor(Math.random() * CHEST_LOOT.emberDice);
      emberDelta = gain;
      const found: string[] = [];
      const potionKind = weightedPotionPick(Math.random);
      const recipient = Object.keys(HERO_BASE_CLASS).find(
        (hero) => (test || heroRecruited(hero, save.completed)) && (bags[hero]?.[potionKind] ?? 0) < POTION_CARRY_MAX[potionKind],
      );
      if (recipient) {
        bags = { ...bags, [recipient]: { ...(bags[recipient] ?? EMPTY_BAG), [potionKind]: (bags[recipient]?.[potionKind] ?? 0) + 1 } };
        found.push(POTIONS[potionKind].name);
      }
      if (Math.random() < CHEST_LOOT.gearChance) {
        const drop = weightedLootPick(Math.random, MAX_LEVEL, new Set(Object.keys(save.weapons)));
        const probe =
          drop.kind === "weapon"
            ? { ...save, weapons: { ...weapons, [drop.id]: 0 } }
            : { ...save, looseEquipment: { ...looseEquipment, [drop.id]: (looseEquipment[drop.id] ?? 0) + 1 } };
        if (partyBagHasRoom(probe, 0, test)) {
          if (drop.kind === "weapon") {
            weapons = { ...weapons, [drop.id]: 0 };
            found.push(WEAPONS[drop.id]!.name);
          } else {
            looseEquipment = { ...looseEquipment, [drop.id]: (looseEquipment[drop.id] ?? 0) + 1 };
            found.push(EQUIPMENT[drop.id]!.name);
          }
        }
      }
      if (Math.random() < 0.4) {
        const qty = 1 + Math.floor(Math.random() * 4);
        rationsDelta += qty;
        found.push(`Rações ×${qty}`);
      }
      event = { kind: "encounter", text: `${pick.text} +${gain} Gold${found.length > 0 ? " · achou " + found.join(", ") : ""}` };
    } else {
      // 1d8 rations lost, rolled fresh each time rather than a flat amount — the exact
      // count is folded into the text shown to the player, not just implied by the flavor
      // line.
      const rationsLost = pick.rationsDice ? 1 + Math.floor(Math.random() * pick.rationsDice) : 0;
      rationsDelta = -rationsLost;
      const goldLost = pick.goldLossDice ? Math.min(save.ember, 1 + Math.floor(Math.random() * pick.goldLossDice)) : 0;
      emberDelta = (pick.ember ?? 0) - goldLost;
      let lostItem = "";
      if (pick.losePotion) {
        const carriedPotions = Object.entries(bags).flatMap(([hero, bag]) =>
          Object.keys(POTIONS)
            .filter((kind) => (bag?.[kind as keyof typeof POTIONS] ?? 0) > 0)
            .map((kind) => ({ hero, kind: kind as keyof typeof POTIONS })),
        );
        const lost = carriedPotions[Math.floor(Math.random() * carriedPotions.length)];
        if (lost) {
          bags = { ...bags, [lost.hero]: { ...bags[lost.hero]!, [lost.kind]: Math.max(0, bags[lost.hero]![lost.kind] - 1) } };
          lostItem = `−1 ${POTIONS[lost.kind].name}`;
        }
      }
      if (pick.loseLockpick) {
        const holders = Object.entries(bags).filter(([, bag]) => (bag?.lockpick ?? 0) > 0);
        const holder = holders[Math.floor(Math.random() * holders.length)];
        if (holder) {
          const [hero, bag] = holder;
          bags = { ...bags, [hero]: { ...bag, lockpick: Math.max(0, bag.lockpick - 1) } };
          lostItem = "−1 Gazua";
        }
      }
      if (pick.alertDays) alertStreak = pick.alertDays;
      event = {
        kind: "encounter",
        text: [
          pick.text,
          rationsLost > 0 ? `−${rationsLost} ${rationsLost === 1 ? "ração" : "rações"}` : "",
          goldLost > 0 ? `−${goldLost} Gold` : "",
          lostItem,
          pick.alertDays ? `chance de emboscada dobrada por ${pick.alertDays} dias` : "",
        ].filter(Boolean).join(" · "),
      };
    }
  }

  if (diseaseText && event?.kind !== "battle") {
    event = event ? { ...event, text: `${event.text} · ${diseaseText}` } : { kind: "encounter", text: diseaseText };
  }

  const exploredKey = key(toCol, toRow);
  const exploredHexes = (save.exploredHexes ?? []).includes(exploredKey) ? save.exploredHexes : [...(save.exploredHexes ?? []), exploredKey];

  return {
    save: {
      ...save,
      overworldPos: { col: toCol, row: toRow },
      exploredHexes,
      gameClock: save.gameClock + 1,
      overworldMoveBudgetUsed: (save.overworldMoveBudgetUsed ?? 0) + 1,
      heroHunger,
      heroDiseases,
      rations: Math.max(0, rations + rationsDelta),
      ember: Math.max(0, save.ember + emberDelta),
      hungerStreak,
      alertStreak,
      lastRoadEncounterId,
      unitHp,
      weapons,
      looseEquipment,
      bags,
    },
    event,
  };
}
