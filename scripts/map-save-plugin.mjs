/**
 * Dev-only `/__map-save` endpoint: writes a Map Editor draft to a real file
 * under `src/game/maps/`, so a map authored in the browser lands in the repo
 * instead of only in that browser's localStorage.
 *
 * The file name is the map's own scenario id plus a serial — `vau-001.json`,
 * `vau-002.json` — so a map is found again by its name, and every save appends
 * the next serial rather than overwriting the last one (delete the newer file
 * to roll back). `src/game/mapstore.ts` globs the folder and plays the highest
 * serial for each id.
 *
 * `apply: "serve"` keeps the route out of deployed apps: it exists only while
 * `npm run dev` is running, which is the only time there is a repo to write to.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAP_SAVE_ROUTE = "/__map-save";

/** Sets how many missions a location is meant to hold — see src/game/map-slots.json. */
export const SLOTS_SAVE_ROUTE = "/__map-slots";

/** Sets the play order of the missions at each location — see src/game/map-order.json. */
export const ORDER_SAVE_ROUTE = "/__map-order";

/** Sets the campaign progression order of the world-map locations. */
export const LOCATION_ORDER_SAVE_ROUTE = "/__location-order";
/** Stores the standalone random-encounter regions used by the Map Editor. */
export const RANDOM_ENCOUNTERS_SAVE_ROUTE = "/__random-encounters";

/** Where saved maps live, relative to the project root. */
export const MAPS_DIR = join("src", "game", "maps");

/** The per-location slot counts, relative to the project root. Config, not a version:
 * a new count replaces the old one rather than appending a serial. */
export const SLOTS_FILE = join("src", "game", "map-slots.json");

/** Per-location mission order, same config-not-a-version treatment as the slot counts. */
export const ORDER_FILE = join("src", "game", "map-order.json");

/** Ordered location ids, separate from the per-location mission lists. */
export const LOCATION_ORDER_FILE = join("src", "game", "location-order.json");
export const RANDOM_ENCOUNTERS_FILE = join("src", "game", "random-encounters.json");

/** Deletes one saved map file — the editor's way to throw away a version it created.
 * Saves only ever stack up, so without this the folder is write-only. */
export const MAP_DELETE_ROUTE = "/__map-delete";
/** Lists the actual map files on disk for one Map ID. */
export const MAP_LIST_ROUTE = "/__map-list";

/** A scenario id is a file name, so it may only hold characters that are safe in one —
 * this is what stops a crafted id from writing outside the maps folder. */
export function isSafeMapId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 64 && /^[a-z0-9][a-z0-9-]*$/.test(id);
}

/** The next unused serial for a scenario: one past the highest `<id>NNN.json`
 * already on disk, so saves stack up instead of clobbering each other. */
export function nextSerial(dir, id) {
  let highest = 0;
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 1;
  }
  // Accept the former id-### form while migrating; writes below use the compact
  // id### convention and therefore can never overwrite an older save.
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedId}(?:-)?(\\d{3})\\.json$`);
  for (const name of entries) {
    const match = pattern.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

/** A name this route is allowed to delete: the current id### form or the compatible
 * former id-### form. No path separators can survive it, so the name can never
 * reach outside the maps folder, and README.md and anything hand-added is not matchable. */
export function isSavedMapFile(name) {
  if (typeof name !== "string") return false;
  return /^[a-z0-9][a-z0-9-]*?(?:-)?\d{3}\.json$/.test(name);
}

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("map too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Reads a JSON file back after writing it, so a save can be confirmed rather than assumed.
 * Returns null if it cannot be read, which is itself worth reporting. */
function readBack(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function mapSavePlugin() {
  let watchedMapsDir = "";
  return {
    name: "ember:map-save",
    apply: "serve",
    configResolved(config) {
      watchedMapsDir = join(config.root, MAPS_DIR).replaceAll("\\", "/");
    },
    // Map JSONs are written by this plugin (or by hand, or by another tool entirely — any
    // of the three). The editor already refreshes its own picker lists straight from the
    // confirmed save response, so a full browser reload here would only throw the author
    // out of the editor without making the save safer — that's still suppressed below.
    // But mapstore.ts's `import.meta.glob("./maps/*.json", { eager: true })` gets baked
    // into ITS OWN transformed module at the moment Vite first transforms it, and without
    // an explicit invalidation here Vite has no way to know that module's result is stale —
    // it never re-transforms mapstore.ts again, EVEN ON A FULL PAGE RELOAD, until the dev
    // server itself restarts. That's what let a just-saved/just-deleted/hand-written map
    // file silently vanish from every list that resolves through ALL_MISSIONS/missionById
    // (the campaign screen, "Carregar mapa da campanha", etc.) — not stale until refreshed,
    // stale until the whole server restarts. Invalidating the module here (without forcing
    // the reload) means the very next real page load picks up the current file list, no
    // restart required.
    handleHotUpdate(ctx) {
      const changed = ctx.file.replaceAll("\\", "/");
      if (watchedMapsDir && changed.startsWith(`${watchedMapsDir}/`) && changed.endsWith(".json")) {
        const mapstoreFile = join(ctx.server.config.root, "src", "game", "mapstore.ts");
        for (const mod of ctx.server.moduleGraph.getModulesByFile(mapstoreFile) ?? []) {
          ctx.server.moduleGraph.invalidateModule(mod);
        }
        return [];
      }
    },
    configureServer(server) {
      const dir = join(server.config.root, MAPS_DIR);
      const slotsPath = join(server.config.root, SLOTS_FILE);
      const orderPath = join(server.config.root, ORDER_FILE);
      const locationOrderPath = join(server.config.root, LOCATION_ORDER_FILE);
      const randomEncountersPath = join(server.config.root, RANDOM_ENCOUNTERS_FILE);
      server.middlewares.use((req, res, next) => {
        const pathOnly = (req.url ?? "").split("?", 1)[0];
        const isMap = pathOnly === MAP_SAVE_ROUTE;
        const isSlots = pathOnly === SLOTS_SAVE_ROUTE;
        const isOrder = pathOnly === ORDER_SAVE_ROUTE;
        const isLocationOrder = pathOnly === LOCATION_ORDER_SAVE_ROUTE;
        const isRandomEncounters = pathOnly === RANDOM_ENCOUNTERS_SAVE_ROUTE;
        const isDelete = pathOnly === MAP_DELETE_ROUTE;
        const isList = pathOnly === MAP_LIST_ROUTE;
        const method = (req.method ?? "GET").toUpperCase();
        // A GET on one of the three config routes reads the file back as-is (matched below,
        // before the isList branch) — see the isConfigRead block's own comment for why this
        // exists: the Locais screen needs a way to refresh its state from disk before it can
        // safely save, or a stale browser tab silently deletes whatever it doesn't know about.
        const isConfigRead = (isOrder || isSlots || isLocationOrder) && method === "GET";
        if (
          (!isMap && !isSlots && !isOrder && !isLocationOrder && !isRandomEncounters && !isDelete && !isList) ||
          (isList || isConfigRead ? method !== "GET" : method !== "POST")
        ) {
          next();
          return;
        }
        const reply = (status, payload) => {
          const body = Buffer.from(JSON.stringify(payload), "utf8");
          res.statusCode = status;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("cache-control", "no-cache");
          res.setHeader("content-length", String(body.byteLength));
          res.end(body);
        };
        // Read one config file back exactly as saved — the Locais screen calls this right
        // before it lets the author start editing, so its baseline can never be older than
        // "when I opened this screen" instead of "whenever this browser tab first mounted",
        // which is what let a stale save silently wipe out another location's real data (a
        // save posts EVERY location's current array, including ones this tab never learned
        // about; the isOrder/isSlots handlers below drop anything genuinely empty, so a
        // location the client never heard of — sent as [] purely from being stale, not from
        // the author actually clearing it — was indistinguishable from a real deletion).
        if (isConfigRead) {
          const path = isOrder ? orderPath : isSlots ? slotsPath : locationOrderPath;
          const fallback = isLocationOrder ? [] : {};
          reply(200, { ok: true, value: readBack(path) ?? fallback });
          return;
        }
        if (isList) {
          const id = new URL(req.url ?? "", "http://localhost").searchParams.get("id") ?? "";
          if (id && !isSafeMapId(id)) {
            reply(400, { ok: false, error: "id inválido" });
            return;
          }
          let names = [];
          try { names = readdirSync(dir).filter(isSavedMapFile); } catch { /* an empty folder is valid */ }
          const allFiles = names
            .map((name) => ({ ...(readBack(join(dir, name)) ?? {}), file: name }))
            .filter((entry) => entry?.draft?.id)
            .sort((a, b) => Number(a.serial ?? 0) - Number(b.serial ?? 0));
          if (!id) {
            const latest = new Map();
            for (const entry of allFiles) latest.set(entry.draft.id, entry);
            const scenarios = [...latest.values()]
              .map((entry) => ({ id: entry.draft.id, title: entry.draft.title || entry.draft.id, index: Number(entry.draft.index ?? 0) }))
              .sort((a, b) => a.title.localeCompare(b.title));
            reply(200, { ok: true, scenarios });
            return;
          }
          const files = allFiles.filter((entry) => entry.draft.id === id);
          reply(200, { ok: true, files });
          return;
        }
        readBody(req, 8 * 1024 * 1024)
          .then((raw) => {
            if (isLocationOrder) {
              const wanted = JSON.parse(raw);
              const cleaned = [...new Set(Array.isArray(wanted) ? wanted.filter((id) => isSafeMapId(id)) : [])];
              writeFileSync(locationOrderPath, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
              reply(200, { ok: true, file: LOCATION_ORDER_FILE, order: cleaned, onDisk: readBack(locationOrderPath) });
              return;
            }
            if (isRandomEncounters) {
              const requested = JSON.parse(raw);
              const seenRegions = new Set();
              const regions = Array.isArray(requested?.regions) ? requested.regions.flatMap((region) => {
                const id = typeof region?.id === "string" ? region.id : "";
                if (!isSafeMapId(id) || seenRegions.has(id)) return [];
                seenRegions.add(id);
                const name = typeof region?.name === "string" ? region.name.trim().slice(0, 80) : id;
                const seenMaps = new Set();
                const encounterIds = Array.isArray(region?.encounterIds) ? region.encounterIds.filter((mapId) => isSafeMapId(mapId) && !seenMaps.has(mapId) && !!seenMaps.add(mapId)) : [];
                return [{ id, name: name || id, encounterIds }];
              }) : [];
              const cleaned = { regions };
              writeFileSync(randomEncountersPath, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
              reply(200, { ok: true, file: RANDOM_ENCOUNTERS_FILE, regions, onDisk: readBack(randomEncountersPath) });
              return;
            }
            if (isOrder) {
              const wanted = JSON.parse(raw);
              const cleaned = {};
              for (const [locationId, ids] of Object.entries(wanted ?? {})) {
                if (!isSafeMapId(locationId) || !Array.isArray(ids)) continue;
                const list = ids.filter((id) => isSafeMapId(id));
                if (list.length > 0) cleaned[locationId] = list;
              }
              writeFileSync(orderPath, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
              // Read it straight back off disk: the confirmation the editor shows is then
              // proof the file exists and holds this, not a promise that a write was tried.
              reply(200, { ok: true, file: ORDER_FILE, order: cleaned, onDisk: readBack(orderPath) });
              return;
            }
            if (isSlots) {
              const wanted = JSON.parse(raw);
              const cleaned = {};
              for (const [id, count] of Object.entries(wanted ?? {})) {
                if (!isSafeMapId(id)) continue;
                const n = Math.floor(Number(count));
                if (Number.isFinite(n) && n > 0) cleaned[id] = n;
              }
              writeFileSync(slotsPath, JSON.stringify(cleaned, null, 2) + "\n", "utf8");
              reply(200, { ok: true, file: SLOTS_FILE, slots: cleaned, onDisk: readBack(slotsPath) });
              return;
            }
            if (isDelete) {
              const name = JSON.parse(raw)?.file;
              if (!isSavedMapFile(name)) {
                reply(400, { ok: false, error: `nome de arquivo inválido: ${String(name)}` });
                return;
              }
              const full = join(dir, name);
              if (!existsSync(full)) {
                reply(404, { ok: false, error: `${name} não existe` });
                return;
              }
              unlinkSync(full);
              // Same evidence rule as a save: check the disk rather than assume.
              reply(200, { ok: true, file: `${MAPS_DIR}/${name}`, stillOnDisk: existsSync(full) });
              return;
            }
            const draft = JSON.parse(raw);
            if (!isSafeMapId(draft?.id)) {
              reply(400, { ok: false, error: "id inválido — use letras minúsculas, números e hífens" });
              return;
            }
            mkdirSync(dir, { recursive: true });
            const serial = nextSerial(dir, draft.id);
            const file = `${draft.id}${String(serial).padStart(3, "0")}.json`;
            const full = join(dir, file);
            writeFileSync(full, JSON.stringify({ serial, savedAt: Date.now(), draft }, null, 2) + "\n", "utf8");
            reply(200, { ok: true, serial, file: `${MAPS_DIR}/${file}`, bytes: statSync(full).size });
          })
          .catch((err) => reply(400, { ok: false, error: String(err?.message ?? err) }));
      });
    },
  };
}
