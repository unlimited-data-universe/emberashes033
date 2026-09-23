import { isProjectile, rollDice, TERRAIN, WEAPONS, weaponPreview, weaponRoll } from "./data";
import { canHitFrom } from "./pathfinding";
import type { Forecast, TerrainId, Unit } from "./types";

/** What a unit's own stat contributes to a hit: half of ATK, or half of MAG for a caster.
 *
 * Halved because the stat used to be the whole story — a point of ATK was a point of
 * damage, so levels drowned out what a unit was carrying. At half weight the weapon and
 * spell dice decide as much as the stat does. Rounded down; there are no half points. */
export function powerOf(unit: Unit): number {
  return Math.floor((unit.mag > 0 ? unit.mag : unit.atk) / 2);
}

/** What the defender's stat takes off, halved to match powerOf — DEF against a weapon, RES
 * against a caster. Halving only the attacking side would have cut damage to a third
 * rather than half, since this is subtracted after. */
export function protOf(attacker: Unit, defender: Unit): number {
  return Math.floor((attacker.mag > 0 ? defender.res : defender.def) / 2);
}

/** High ground's attack bonus, as a fraction of the attacker's own ATK (or MAG for a
 * caster) instead of the old flat +2 — so it keeps mattering as a character grows instead
 * of shrinking to nothing at high levels. The range bonus (effectiveMaxRange /
 * effectiveMaxRangeAt) is untouched: still a flat +1 for a ranged weapon. */
const HIGH_GROUND_ATK_PCT = 0.1;

function terrainBonus(attacker: Unit, defender: Unit, attTile: TerrainId, defTile: TerrainId): { atk: number; def: number } {
  const attT = TERRAIN[attTile];
  const defT = TERRAIN[defTile];
  let def = defT.def;
  if (isProjectile(attacker) && defT.cover) def += defT.cover;
  const atk = attT.height ? Math.round((attacker.mag > 0 ? attacker.mag : attacker.atk) * HIGH_GROUND_ATK_PCT) : attT.atk;
  return { atk, def };
}

/** A weapon tuned for one specific class (a staff named after a school of magic, say) hits
 * 10% harder in that class's own hands — everyone else in its usableBy pool can still wield
 * it at no penalty, just without this. */
const WEAPON_CLASS_BONUS_MUL = 1.1;
function weaponClassBonusMul(attacker: Unit): number {
  const weapon = attacker.weaponId ? WEAPONS[attacker.weaponId] : null;
  return weapon?.bonusClass === attacker.classId ? WEAPON_CLASS_BONUS_MUL : 1;
}

/** Full-strength ATT/DEF (or MAG/RES for a caster) feeding ONLY the hit-chance formulas
 * below — separate from powerOf/protOf's halved stat, which still drives damage exactly as
 * before. Same weapon-roll + terrain bonus inputs damage already uses. */
function effectivePower(
  attacker: Unit,
  defender: Unit,
  weaponOrDiceRoll: number,
  b: { atk: number; def: number },
): { att: number; def: number; magical: boolean } {
  const magical = attacker.mag > 0;
  const att = (magical ? attacker.mag : attacker.atk) + weaponOrDiceRoll + b.atk;
  const def = (magical ? defender.res : defender.def) + b.def;
  return { att, def, magical };
}

/** Physical accuracy: high enough that missing is rare, reserved for a defender who has
 * built up roughly double the attacker's ATT in DEF. */
function physicalHitChance(att: number, def: number): number {
  return Math.min(99, Math.max(75, 90 + (att - def) / 2));
}

/** Magic bypasses dodge/evasion almost entirely — RES only trims an already-near-certain
 * hit, at a quarter the sensitivity of DEF against a physical attack. */
function magicalHitChance(mag: number, res: number): number {
  return Math.min(100, Math.max(85, 95 + (mag - res) / 4));
}

function hitChanceFor(att: number, def: number, magical: boolean): number {
  return magical ? magicalHitChance(att, def) : physicalHitChance(att, def);
}

export function rollDamage(
  attacker: Unit,
  defender: Unit,
  attTile: TerrainId,
  defTile: TerrainId,
  rng: () => number,
): { dmg: number; crit: boolean; landed: boolean; hitChance: number } {
  const b = terrainBonus(attacker, defender, attTile, defTile);
  const weapon = weaponRoll(attacker.weaponId, attacker.weaponEnh, rng);
  const { att, def, magical } = effectivePower(attacker, defender, weapon, b);
  const hitChance = hitChanceFor(att, def, magical);
  if (rng() * 100 >= hitChance) return { dmg: 0, crit: false, landed: false, hitChance };
  const raw = powerOf(attacker) + weapon + b.atk - protOf(attacker, defender) - b.def;
  let dmg = Math.max(1, Math.floor(Math.max(1, raw) * weaponClassBonusMul(attacker)));
  const crit = rng() < 0.08;
  if (crit) dmg = Math.max(1, Math.floor(dmg * 1.5));
  return { dmg, crit, landed: true, hitChance };
}

/** Same formula as rollDamage, but rolling explicit dice instead of the attacker's
 * equipped main-hand weapon — for an off-hand weapon attack, whose dice come from the
 * EquipmentDef in the offHand slot rather than WEAPONS[attacker.weaponId]. */
export function rollDamageCustom(
  attacker: Unit,
  defender: Unit,
  attTile: TerrainId,
  defTile: TerrainId,
  dice: number,
  faces: number,
  bonus: number,
  rng: () => number,
): { dmg: number; crit: boolean; landed: boolean; hitChance: number } {
  const b = terrainBonus(attacker, defender, attTile, defTile);
  const weapon = rollDice(dice, faces, bonus, rng);
  const { att, def, magical } = effectivePower(attacker, defender, weapon, b);
  const hitChance = hitChanceFor(att, def, magical);
  if (rng() * 100 >= hitChance) return { dmg: 0, crit: false, landed: false, hitChance };
  const raw = powerOf(attacker) + weapon + b.atk - protOf(attacker, defender) - b.def;
  let dmg = Math.max(1, Math.floor(raw));
  const crit = rng() < 0.08;
  if (crit) dmg = Math.max(1, Math.floor(dmg * 1.5));
  return { dmg, crit, landed: true, hitChance };
}

export function previewDamage(
  attacker: Unit,
  defender: Unit,
  attTile: TerrainId,
  defTile: TerrainId,
): { dmg: number; hitChance: number } {
  const b = terrainBonus(attacker, defender, attTile, defTile);
  const weapon = weaponPreview(attacker.weaponId, attacker.weaponEnh);
  const { att, def, magical } = effectivePower(attacker, defender, weapon, b);
  const hitChance = hitChanceFor(att, def, magical);
  const raw = powerOf(attacker) + weapon + b.atk - protOf(attacker, defender) - b.def;
  const dmg = Math.max(1, Math.floor(Math.max(1, raw) * weaponClassBonusMul(attacker)));
  return { dmg, hitChance: Math.round(hitChance) };
}

export function canCounter(
  attacker: Unit,
  defender: Unit,
  from: { x: number; y: number },
  tiles: TerrainId[],
  cols: number,
): boolean {
  if (!defender.alive) return false;
  return canHitFrom(defender, { x: defender.x, y: defender.y }, { ...attacker, x: from.x, y: from.y }, tiles, cols, undefined, true);
}

export function makeForecast(
  attacker: Unit,
  defender: Unit,
  attTile: TerrainId,
  defTile: TerrainId,
  tiles: TerrainId[],
  cols: number,
): Forecast {
  const out = previewDamage(attacker, defender, attTile, defTile);
  const counter = canCounter(attacker, defender, { x: attacker.x, y: attacker.y }, tiles, cols);
  const back = counter ? previewDamage(defender, attacker, defTile, attTile) : null;
  return {
    attacker: attacker.id,
    defender: defender.id,
    dmgOut: out.dmg,
    dmgBack: back?.dmg ?? 0,
    hitOut: out.hitChance,
    hitBack: back?.hitChance ?? 0,
    canCounter: counter,
    critOut: false,
    kill: out.dmg >= defender.hp,
  };
}

export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
