/** Maps authored in the Map Editor, saved as real files under src/game/maps/.
 *
 * The editor's "Salvar" posts a draft to the dev-only route in
 * scripts/map-save-plugin.mjs, which writes src/game/maps/<id><serial>.json —
 * "vau001.json", "vau002.json", "misty-cave001.json". Serials are never
 * overwritten: each save appends the next number, so an edit can always be
 * rolled back to an earlier one by deleting the newer file.
 *
 * A saved map is found by its scenario id (its file name) and, when it names a
 * locationId, shows up at that spot on the world map. The highest serial for a
 * given id is the one that plays.
 *
 * Nothing here runs the procedural passes in data.ts (rockifyColumns,
 * decorateOpenTerrain): those exist to dress the hand-written RAW_MISSIONS, and
 * a map arranged by hand in the editor loads exactly as it was arranged.
 */
import { MISSIONS, TILE_CHAR, WORLD_LOCATIONS } from "./data";
import SLOT_CONFIG from "./map-slots.json";
import ORDER_CONFIG from "./map-order.json";
import LOCATION_ORDER_CONFIG from "./location-order.json";
import RANDOM_ENCOUNTER_CONFIG from "./random-encounters.json";
import type { ClassId, DecorationPlacement, DialogTree, ElementalFxPlacement, Mission, Spawn, TerrainId, WinCondition, WorldLocation } from "./types";

/** A spawn as edited in the Map Editor — the real Spawn shape plus a per-spawn test
 * level, which only exists for "Testar" (balance testing). It never leaves the editor:
 * draftToMission() strips it back down to a plain Spawn before export/playtest. */
export interface DraftSpawn extends Spawn {
  level: number;
}

export interface MapDraft {
  /** Which campaign scenario this map authors for — matches a real Mission.id (e.g.
   * "o-vau") to version-edit that scenario, or any free id for a standalone map with no
   * campaign slot. Versions are grouped and saved under this id — it's the "Cenário
   * alvo" the user assigns, not a per-edit-session unique key. It is also the file
   * name saved maps get, so it's how a map is found again. */
  id: string;
  /** Mission.index of the scenario being edited (enemy scaling, procedural terrain hash
   * — see enemyLevelFor). 0 for a standalone map with no real campaign slot. */
  index: number;
  title: string;
  place: string;
  briefing: string;
  objective: string;
  win: WinCondition;
  /** Track file name for this map, or absent for its usual theme. */
  music?: string;
  hub: boolean;
  /** False to load this map exactly as painted, with no procedural scatter over it — see
   * Mission.autoTactics. Carried through Exportar so a map pasted into data.ts keeps it. */
  autoTactics: boolean;
  /** True to play this map under fog of war — see Mission.fog. Absent on every map
   * saved before fog existed, which reads as off. */
  fog?: boolean;
  /** See Mission.environment/sunIntensity/ambientIntensity — real-3D-renderer lighting
   * controls, author-tunable per map so the editor is the one place these live, not a
   * source-code table only a developer can touch. */
  environment?: "outdoor" | "indoor";
  sunIntensity?: number;
  ambientIntensity?: number;
  /** See Mission.mistIntensity. */
  mistIntensity?: number;
  /** See Mission.mistType. */
  mistType?: "mist2" | "mist3" | "mist4" | "vignette" | "vignette2" | "vignette3" | "vignette4";
  /** See Mission.bloomIntensity. */
  bloomIntensity?: number;
  /** See Mission.mistSpeed. */
  mistSpeed?: number;
  /** See Mission.wispIntensity. */
  wispIntensity?: number;
  /** See Mission.wispSpeed. */
  wispSpeed?: number;
  /** See Mission.wispColor. */
  wispColor?: number;
  /** Which world map location this map hangs off, by WorldLocation.id — "" for a map
   * that shouldn't appear on the map at all. A map already reachable through its
   * scenario's own location keeps showing up there whatever this says; this is what
   * puts a NEW map somewhere (Village, Cemetery, Misty Cave, ...). */
  locationId: string;
  cols: number;
  rows: number;
  tiles: TerrainId[];
  /** Art variant per tile (same indexing as tiles) — which numbered version (001, 002,
   * ...) paints there. Defaults to 0 (the "001" file, safe for existing missions). */
  tileVariants: number[];
  /** Ground restored beneath removable terrain props. Set by “Substituir base”. */
  baseTile?: TerrainId;
  baseVariant?: number;
  /** How far each tile is turned, in sixths of a circle (same indexing as tiles). Optional:
   * a map saved before hex rotation existed has no such key, read as "none turned". */
  tileRots?: number[];
  decorations: DecorationPlacement[];
  /** Permanent elemental GPU FX (lava fire, icy glints, ...) placed on this map — see
   * types.ts ElementalFxPlacement. Optional: a draft saved before this existed has none. */
  elementalFx?: ElementalFxPlacement[];
  playerSpawns: DraftSpawn[];
  enemySpawns: DraftSpawn[];
  /** Wild things on no side. Optional: map files saved before neutrals existed have no such
   * key, and every reader has to treat a missing list as an empty one. */
  neutralSpawns?: DraftSpawn[];
  /** See Mission.introDialog/introDialogEnabled — shown once, before the player can act. */
  introDialog?: DialogTree;
  introDialogEnabled?: boolean;
  /** See Mission.outroDialog/outroDialogEnabled — shown once victory is confirmed. */
  outroDialog?: DialogTree;
  outroDialogEnabled?: boolean;
}

/** One saved map file. `serial` matches the number in the file name. */
export interface MapFile {
  serial: number;
  savedAt: number;
  draft: MapDraft;
  /** Actual repository filename. Older saves used `id-###.json`; preserve it so
   * the editor can still display and delete those files accurately. */
  file?: string;
}

/** Separate authored encounters from the campaign's world-map locations. Regions are data,
 * not hard-coded game logic, so the editor can receive new biomes without engine changes. */
export interface RandomEncounterRegion {
  id: string;
  name: string;
  encounterIds: string[];
}

function cleanEncounterRegions(value: unknown): RandomEncounterRegion[] {
  const rows = value && typeof value === "object" && "regions" in value ? (value as { regions?: unknown }).regions : [];
  if (!Array.isArray(rows)) return [];
  const used = new Set<string>();
  return rows.flatMap((row): RandomEncounterRegion[] => {
    if (!row || typeof row !== "object") return [];
    const candidate = row as { id?: unknown; name?: unknown; encounterIds?: unknown };
    if (typeof candidate.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(candidate.id) || used.has(candidate.id)) return [];
    used.add(candidate.id);
    return [{
      id: candidate.id,
      name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : candidate.id,
      encounterIds: Array.isArray(candidate.encounterIds) ? candidate.encounterIds.filter((id): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9-]*$/.test(id)) : [],
    }];
  });
}

export const RANDOM_ENCOUNTER_REGIONS = cleanEncounterRegions(RANDOM_ENCOUNTER_CONFIG);
export const RANDOM_ENCOUNTER_IDS = new Set(RANDOM_ENCOUNTER_REGIONS.flatMap((region) => region.encounterIds));
export function isRandomEncounter(id: string): boolean { return RANDOM_ENCOUNTER_IDS.has(id); }

/** Old saves/drafts from before "butcher" was split into "punisher" (unchanged, original
 * unit) and "theButcher" (new, separate unit) still spell the old classId — remap it here
 * so a browser-local draft or an older exported map file doesn't point at a class id that
 * no longer exists (which crashed/froze the editor on load instead of failing loudly). */
function legacyClassId(id: string): ClassId {
  return (id === "butcher" ? "punisher" : id) as ClassId;
}

/** Rewrites every spawn's classId through legacyClassId — applied at every point a
 * MapDraft is actually read (a saved file, an activated draft, a stored version), not
 * just at play time (draftToMission), so the editor's own direct CLASSES[classId] lookups
 * (spawn list labels, icons, ...) never see a stale id and crash/freeze on load. */
function normalizeDraft(draft: MapDraft): MapDraft {
  return {
    ...draft,
    playerSpawns: draft.playerSpawns.map((s) => ({ ...s, classId: legacyClassId(s.classId) })),
    enemySpawns: draft.enemySpawns.map((s) => ({ ...s, classId: legacyClassId(s.classId) })),
    neutralSpawns: draft.neutralSpawns?.map((s) => ({ ...s, classId: legacyClassId(s.classId) })),
  };
}

export function draftToMission(d: MapDraft): Mission {
  const layout: string[] = [];
  for (let r = 0; r < d.rows; r++) {
    let row = "";
    for (let c = 0; c < d.cols; c++) row += TILE_CHAR[d.tiles[r * d.cols + c] ?? "plains"];
    layout.push(row);
  }
  return {
    id: d.id,
    index: d.index,
    // This campaign chapter has one canonical name. Old browser-local activated drafts
    // still carry "Ponte de Ferro" and otherwise override every newer repository file.
    // Resolve it here, at the common path used by editor versions, activations and play.
    title: d.id === "thebridge" ? "A Ponte de Pedra" : d.title,
    place: d.place,
    briefing: d.briefing,
    objective: d.objective,
    win: d.win,
    cols: d.cols,
    rows: d.rows,
    layout,
    tileVariants: d.tileVariants.some((v) => v) ? d.tileVariants : undefined,
    baseTile: d.baseTile,
    baseVariant: d.baseVariant,
    tileRots: d.tileRots?.some((r) => r) ? d.tileRots : undefined,
    decorations: d.decorations.length > 0 ? d.decorations : undefined,
    elementalFx: d.elementalFx && d.elementalFx.length > 0 ? d.elementalFx : undefined,
    playerSpawns: d.playerSpawns.map(({ level: _level, ...s }) => ({ ...s, classId: legacyClassId(s.classId) })),
    enemySpawns: d.enemySpawns.map(({ level: _level, ...s }) => ({ ...s, classId: legacyClassId(s.classId) })),
    neutralSpawns: d.neutralSpawns?.length ? d.neutralSpawns.map(({ level: _level, ...s }) => ({ ...s, classId: legacyClassId(s.classId) })) : undefined,
    music: d.music || undefined,
    hub: d.hub || undefined,
    autoTactics: d.autoTactics ? undefined : false,
    fog: d.fog ? true : undefined,
    environment: d.environment === "indoor" ? "indoor" : undefined,
    sunIntensity: typeof d.sunIntensity === "number" ? d.sunIntensity : undefined,
    ambientIntensity: typeof d.ambientIntensity === "number" ? d.ambientIntensity : undefined,
    mistIntensity: typeof d.mistIntensity === "number" ? d.mistIntensity : undefined,
    mistSpeed: typeof d.mistSpeed === "number" ? d.mistSpeed : undefined,
    mistType: d.mistType === "mist3" || d.mistType === "mist4" || d.mistType === "vignette" || d.mistType === "vignette2" || d.mistType === "vignette3" || d.mistType === "vignette4" ? d.mistType : undefined,
    bloomIntensity: typeof d.bloomIntensity === "number" ? d.bloomIntensity : undefined,
    wispIntensity: typeof d.wispIntensity === "number" ? d.wispIntensity : undefined,
    wispSpeed: typeof d.wispSpeed === "number" ? d.wispSpeed : undefined,
    wispColor: typeof d.wispColor === "number" ? d.wispColor : undefined,
    introDialog: d.introDialog,
    introDialogEnabled: d.introDialogEnabled,
    outroDialog: d.outroDialog,
    outroDialogEnabled: d.outroDialogEnabled,
  };
}

/** Pads a serial the way saved file names do — three digits, same convention as the
 * numbered art variants (plains001.png). */
export function serialLabel(serial: number): string {
  return String(serial).padStart(3, "0");
}

export function mapFileName(id: string, serial: number): string {
  return `${id}${serialLabel(serial)}.json`;
}

const MAP_MODULES = import.meta.glob<MapFile>("./maps/*.json", { eager: true, import: "default" });

/** Keep the source filename alongside imported JSON. This makes the filename migration
 * non-destructive: new saves use id###, while old id-### saves remain manageable. */
export function savedMapFiles(): MapFile[] {
  return Object.entries(MAP_MODULES).flatMap(([path, file]) => {
    if (!file || typeof file !== "object") return [];
    const name = path.split("/").pop();
    return [{ ...file, file: name, draft: normalizeDraft(file.draft) }];
  });
}

/** Every saved file, newest serial per scenario id. Two files for the same id (vau-001,
 * vau-002) are the same scenario twice — the higher serial is the one that plays, the
 * lower stays on disk as the rollback. */
function latestPerScenario(): Map<string, MapFile> {
  const best = new Map<string, MapFile>();
  for (const file of savedMapFiles()) {
    if (!file || typeof file !== "object" || !file.draft?.id) continue;
    const current = best.get(file.draft.id);
    if (!current || file.serial > current.serial) best.set(file.draft.id, file);
  }
  return best;
}

const LATEST = latestPerScenario();

/** Saved maps, as playable Missions. */
export const SAVED_MISSIONS: Mission[] = [...LATEST.values()].map((f) => draftToMission(f.draft));

/** Every saved version on disk for one scenario id, oldest serial first — what the
 * editor lists so an earlier save can be reopened. */
export function savedVersionsFor(id: string): MapFile[] {
  return savedMapFiles()
    .filter((f): f is MapFile => !!f && typeof f === "object" && f.draft?.id === id)
    .sort((a, b) => a.serial - b.serial);
}

export function latestSerialFor(id: string): number {
  return LATEST.get(id)?.serial ?? 0;
}

/** Every scenario that has at least one saved file, with how many files it has.
 *
 * The editor's picker is built from this. Without it the only way to reach a map saved
 * to disk was to already know its id and type it into "Cenário alvo" — the files were
 * there and the editor offered no way to find them. */
export function savedScenarios(): { id: string; files: number; latest: number }[] {
  const counts = new Map<string, number>();
  for (const file of savedMapFiles()) {
    if (!file || typeof file !== "object" || !file.draft?.id) continue;
    counts.set(file.draft.id, (counts.get(file.draft.id) ?? 0) + 1);
  }
  return [...counts].map(([id, files]) => ({ id, files, latest: latestSerialFor(id) }));
}

/** The newest saved draft on disk for a scenario, or undefined when it has no file. */
export function latestSavedDraft(id: string): MapDraft | undefined {
  return LATEST.get(id)?.draft;
}

/** The campaign, with saved maps applied: a saved map whose id matches a shipped mission
 * replaces it, and one with a new id is appended as a new mission. */
export const ALL_MISSIONS: Mission[] = (() => {
  const saved = new Map(SAVED_MISSIONS.map((m) => [m.id, m]));
  const merged = MISSIONS.map((m) => saved.get(m.id) ?? m);
  const shipped = new Set(MISSIONS.map((m) => m.id));
  for (const m of SAVED_MISSIONS) if (!shipped.has(m.id)) merged.push(m);
  return merged;
})();

/** Browser-local overrides written by the Map Editor's "Ativar" — these are what make an
 * activated edit "the" campaign scenario everywhere the game reads a mission, not only at
 * battle start. Kept here (rather than in GameApp.tsx, where they used to live) so every
 * caller of missionById automatically sees an activation instead of only the one call site
 * that remembered to check for it. */
export const MAP_VERSIONS_KEY = "ember-map-versions";
export const MAP_ACTIVE_KEY = "ember-map-active";
export const MAP_ACTIVE_DRAFTS_KEY = "ember-map-active-drafts";

/** One saved edit of a scenario. Versions never get overwritten — every "Salvar" appends a
 * new serial under the draft's id (the target scenario). "Ativar" a serial to make it the
 * one real campaign play uses instead of the immutable static Mission data; the static
 * data itself is never modified by any of this. */
export interface MapVersion {
  serial: number;
  draft: MapDraft;
  savedAt: number;
}

export function loadVersionStore(): Record<string, MapVersion[]> {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(MAP_VERSIONS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== "object") return {};
    const store = parsed as Record<string, MapVersion[]>;
    return Object.fromEntries(
      Object.entries(store).map(([id, list]) => [id, Array.isArray(list) ? list.map((v) => ({ ...v, draft: normalizeDraft(v.draft) })) : list]),
    );
  } catch {
    return {};
  }
}

/** Returns false when the browser refused the write (private mode, blocked storage,
 * quota) so the caller can say so instead of reporting a save that didn't happen. */
export function saveVersionStore(store: Record<string, MapVersion[]>): boolean {
  try {
    window.localStorage.setItem(MAP_VERSIONS_KEY, JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

/** The Locais screen's own config — which missions each location holds, in what order, and
 * how many it's meant to hold. Saved here as the guaranteed, always-available copy: the dev
 * server's /__map-order etc. routes write the real repo files too when one is running, but
 * that write is best-effort (per direct instruction, Locais must save locally regardless of
 * a dev server or ever touching the repo) and, being shared browser-wide the same way every
 * localStorage key here is, this is also immune to the same-origin-but-different-tab
 * staleness that let one tab's stale "Salvar" silently delete another location's real data
 * (see refreshLocaisState's own comment in GameApp.tsx) — every tab reads and writes this
 * one shared copy instead of each holding its own React-state snapshot from whenever it
 * happened to mount. */
export const LOCAIS_LOCAL_KEY = "ember-locais-local";

export interface LocaisLocal {
  order: Record<string, string[]>;
  slots: Record<string, number>;
  locationOrder: string[];
}

export function loadLocaisLocal(): LocaisLocal | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(LOCAIS_LOCAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const { order, slots, locationOrder } = parsed as Partial<LocaisLocal>;
    if (!order || typeof order !== "object" || !slots || typeof slots !== "object" || !Array.isArray(locationOrder)) return null;
    return { order, slots, locationOrder };
  } catch {
    return null;
  }
}

/** Returns false when the browser refused the write (private mode, blocked storage, quota),
 * same signal as saveVersionStore above — this is the one write Locais can actually promise,
 * so a caller has to be able to tell if even this failed. */
export function saveLocaisLocal(next: LocaisLocal): boolean {
  try {
    window.localStorage.setItem(LOCAIS_LOCAL_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

export function loadActiveVersions(): Record<string, number> {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(MAP_ACTIVE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function saveActiveVersions(map: Record<string, number>) {
  try {
    window.localStorage.setItem(MAP_ACTIVE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

/** The campaign's immutable selection snapshot for an activated scenario id. A serial
 * alone (see loadActiveVersions) can point at a stale/local version list after reloads,
 * so once a snapshot exists play is always resolved from it, never re-derived from the
 * serial. */
export function loadActiveDrafts(): Record<string, MapDraft> {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(MAP_ACTIVE_DRAFTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, MapDraft>).map(([id, draft]) => [id, normalizeDraft(draft)]));
  } catch {
    return {};
  }
}

export function saveActiveDrafts(drafts: Record<string, MapDraft>): boolean {
  try {
    window.localStorage.setItem(MAP_ACTIVE_DRAFTS_KEY, JSON.stringify(drafts));
    return true;
  } catch {
    return false;
  }
}

/** Resolves a mission id for REAL play — the campaign list, the world map, and the battle
 * itself all call this same function, so whatever it decides is final everywhere, not just
 * where someone remembered to special-case it.
 *
 * A real saved FILE is the one durable, inspectable source of truth — per direct, explicit
 * instruction, "the maps I save is the only thing that counts", full stop. It always wins
 * over a browser-local activation now, which used to be checked first and could go stale in
 * ways a file on disk can't (a leftover "Ativar" pointer from a much older session, still
 * sitting in localStorage, silently overriding every file-based fix or edit made since —
 * this is exactly what made a from-scratch fix to a map file look like it "didn't work").
 * The local-activation path only still matters for a scenario that has NEVER been saved to a
 * real file at all — a local-only save made with no dev server available to write one (a
 * built app, a deployed preview) — which is the one case with no file to prefer instead. */
export function missionById(id: string): Mission | undefined {
  if (!LATEST.has(id) && typeof window !== "undefined") {
    const exact = loadActiveDrafts()[id];
    if (exact) return draftToMission(exact);

    // Migrate activations created before snapshots existed, then every later lookup reads
    // the exact draft selected by the editor rather than a different disk version.
    const active = loadActiveVersions()[id];
    if (active) {
      const version = loadVersionStore()[id]?.find((v) => v.serial === active && v.draft.id === id);
      if (version) {
        saveActiveDrafts({ ...loadActiveDrafts(), [id]: version.draft });
        return draftToMission(version.draft);
      }
    }
  }
  return ALL_MISSIONS.find((m) => m.id === id);
}

/** The world map, with saved maps hung off the locations they name. A map whose
 * scenario already belongs to a location stays there; locationId is what places a map
 * that had nowhere to appear before. */
/** What the Map Editor has assigned to each location, in play order — see
 * src/game/map-order.json.
 *
 * This carries membership as well as order. A mission named under a location belongs to
 * that location whatever the shipped data or its own map file says, which is what lets a
 * campaign mission be moved: those have no map file of their own to hold a locationId.
 * Anything not named anywhere keeps its shipped home, and follows the named ones. */
const ORDER: Record<string, string[]> = ORDER_CONFIG;
const LOCATION_ORDER = Array.isArray(LOCATION_ORDER_CONFIG) ? [...new Set(LOCATION_ORDER_CONFIG.filter((id): id is string => typeof id === "string"))] : [];

/** Location a mission has been reassigned to, or undefined if it was never moved. */
function assignedLocation(missionId: string): string | undefined {
  for (const [locationId, ids] of Object.entries(ORDER)) {
    if (ids.includes(missionId)) return locationId;
  }
  return undefined;
}

function inChosenOrder(locationId: string, missionIds: string[]): string[] {
  const wanted = ORDER[locationId] ?? [];
  const first = wanted.filter((id) => missionIds.includes(id));
  return [...first, ...missionIds.filter((id) => !first.includes(id))];
}

/** Campaign progression may differ from map placement. This keeps the authored location
 * sequence while leaving every marker at its own world-map coordinates. */
function inLocationOrder(locations: WorldLocation[], wanted = LOCATION_ORDER): WorldLocation[] {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const ordered = wanted.flatMap((id) => {
    const location = byId.get(id);
    if (!location) return [];
    byId.delete(id);
    return [location];
  });
  return [...ordered, ...locations.filter((location) => byId.has(location.id))];
}

/** The world map, with saved maps placed where they say they belong.
 *
 * A saved map's locationId is authoritative: the mission leaves whichever location used to
 * list it and joins the one it names. That is what makes moving a mission between
 * locations in the editor actually take effect — before, a mission already listed
 * somewhere kept its original home and the choice was silently dropped. */
export const ALL_LOCATIONS: WorldLocation[] = (() => {
  const moved = new Map<string, string>();
  for (const file of LATEST.values()) {
    if (file.draft.locationId) moved.set(file.draft.id, file.draft.locationId);
  }
  // map-order.json wins over a map file's own locationId: it is what the editor's Locais
  // panel writes, and it is the only way to move a mission that has no map file.
  for (const [locationId, ids] of Object.entries(ORDER)) {
    for (const id of ids) moved.set(id, locationId);
  }
  const out = WORLD_LOCATIONS.map((l) => ({
    ...l,
    missionIds: l.missionIds.filter((id) => (moved.has(id) ? moved.get(id) === l.id : true)),
  }));
  for (const [missionId, locationId] of moved) {
    const target = out.find((l) => l.id === locationId);
    if (target && !target.missionIds.includes(missionId)) target.missionIds.push(missionId);
  }
  return inLocationOrder(out).map((l) => ({ ...l, missionIds: inChosenOrder(l.id, l.missionIds) }));
})();

/** Where a mission has been reassigned to, if anywhere — the editor shows this so a moved
 * mission reads as moved rather than as missing from its shipped home. */
export { assignedLocation };

export function locationForMission(missionId: string): WorldLocation | undefined {
  return ALL_LOCATIONS.find((l) => l.missionIds.includes(missionId));
}

export function missionsForLocation(loc: WorldLocation): Mission[] {
  // The caller may hold a campaign order just saved by the editor. Respect that supplied
  // location rather than replacing it with the module's startup snapshot.
  return loc.missionIds.map((id) => missionById(id)).filter((m): m is Mission => !!m);
}

/** Applies an editor-saved Local order to the campaign that is already running. */
export function locationsForOrder(order: Record<string, string[]>, locationOrder: string[] = LOCATION_ORDER): WorldLocation[] {
  const assigned = new Set(Object.values(order).flat());
  const locations = ALL_LOCATIONS.map((loc) => {
    const chosen = order[loc.id] ?? [];
    const unchanged = loc.missionIds.filter((id) => !assigned.has(id) && !chosen.includes(id));
    return { ...loc, missionIds: [...chosen, ...unchanged] };
  });
  return inLocationOrder(locations, locationOrder);
}

/** How many missions a location is meant to end up holding — the plan for it, set in the
 * Map Editor and stored in src/game/map-slots.json. Declaring Misty Cave as 3 says three
 * battles belong there, so the editor can show 1 of 3 filled and 2 still to author.
 *
 * This is authoring bookkeeping only: it does not gate the world map or the campaign. A
 * location plays whatever missions actually exist for it, whether that is under or over
 * the declared count. Unlike a map, the file is config rather than a version — a new
 * count replaces the old one instead of appending a serial. */
const SLOTS: Record<string, number> = SLOT_CONFIG;

export function slotsFor(locationId: string): number {
  const n = SLOTS[locationId];
  return typeof n === "number" && n > 0 ? Math.floor(n) : 0;
}

/** What a location currently holds against what it is meant to hold. `declared` is 0 when
 * no count has been set, which reads as "no plan yet" rather than "zero slots". */
export function locationFill(locationId: string): { filled: number; declared: number; empty: number } {
  const loc = ALL_LOCATIONS.find((l) => l.id === locationId);
  const filled = loc ? loc.missionIds.length : 0;
  const declared = slotsFor(locationId);
  return { filled, declared, empty: Math.max(0, declared - filled) };
}

/** Every location's plan, for the editor's picker. */
export const LOCATION_SLOTS: Record<string, number> = { ...SLOTS };
