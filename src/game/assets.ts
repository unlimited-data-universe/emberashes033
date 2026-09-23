import { DECORATIONS, decorationImage } from "./data";
import type { GameArt, SpriteId, TerrainId } from "./types";

// Number of art variants available per terrain, e.g. plains001.png / plains002.png.
// Index 0 (the "001" file) is what every mission renders with unless it names a
// different variant in Mission.tileVariants — keep it as the tile that's safe
// for existing maps.
export const TILE_VARIANT_COUNT: Record<TerrainId, number> = {
  plains: 17,
  woods: 9,
  ruins: 7,
  water: 22,
  ember: 5,
  hill: 4,
  flame: 3,
  column: 2,
  nave: 2,
  barricade: 1,
  door: 1,
  void: 1,
  snow: 3,
};

/** The art file a tile variant paints with, without path or cache-buster — "woods002".
 * Two variants of the same terrain differ only in art, so this is the only way to tell
 * from a painted map which of them a cell is actually using. */
export function tileVariantName(id: TerrainId, variant: number): string {
  // New ground materials are inserted ahead of the legacy plains without renaming
  // their on-disk files, so saved maps keep their original art available.
  if (id === "plains") {
    if (variant === 0) return "plains016";
    if (variant === 1) return "plains015";
    if (variant === 2) return "plains001";
    if (variant === 15) return "plains017";
    if (variant === 16) return "plains018";
    return `plains${String(variant).padStart(3, "0")}`;
  }
  if (id === "water" && variant === 0) return "water023";
  if (id === "woods") {
    if (variant === 0) return "woods005";
    if (variant === 1) return "woods006";
    if (variant === 6) return "woods007";
    if (variant === 7) return "woods009";
    if (variant === 8) return "woods010";
    return `woods${String(variant - 1).padStart(3, "0")}`;
  }
  if (id === "hill") return `hill${String(variant + 4).padStart(3, "0")}`;
  if (id === "ruins") {
    if (variant === 0) return "ruins005";
    if (variant <= 4) return `ruins${String(variant).padStart(3, "0")}`;
    return `ruins${String(variant + 1).padStart(3, "0")}`;
  }
  return `${id}${String(variant + 1).padStart(3, "0")}`;
}

export function tileVariantSrc(id: TerrainId, variant: number): string {
  return `/game/tiles/${tileVariantName(id, variant)}.png?v=55`;
}
/** Framed portrait art for the sprites that have one; every other sprite falls back to its
 * own first battle-frame, unframed. */
const HERO_PORTRAIT: Partial<Record<string, string>> = {
  defaultWarrior: "/game/portraits/kael.png?v=2",
  kaelFinal: "/game/portraits/kael-final-face-001.jpg?v=1",
  neera: "/game/portraits/neera.png",
  voss: "/game/portraits/voss.png",
  salazar: "/game/portraits/salazar.png",
  aldric: "/game/portraits/aldric-profile-001.jpg?v=3",
  defaultLancer: "/game/portraits/aldric-profile-001.jpg?v=3",
  sandoval: "/game/portraits/sandoval-001.jpg?v=1",
  conjurer: "/game/portraits/conjurer-002.png?v=2",
  // Malrec is the named Conjurer hero: always use his face portrait, never a battle sprite frame.
  malrec: "/game/portraits/conjurer-002.png?v=2",
  theButcher: "/game/portraits/the-butcher-portrait-001.jpg?v=1",
};

/** The one place the portrait-or-sprite-frame fallback lives — used by the unit inspect
 * popup, the footer portrait button, and DialogOverlay. Every "framed" portrait renders in
 * the same fixed box via object-cover, so the frame is always the same size regardless of
 * the source image's own dimensions. */
export function portraitFor(sprite: SpriteId): { src: string; framed: boolean } {
  const framed = HERO_PORTRAIT[sprite];
  return framed ? { src: framed, framed: true } : { src: `/game/sprites/${sprite}/1.png`, framed: false };
}

const TILES = Object.keys(TILE_VARIANT_COUNT) as TerrainId[];
const SPRITES: SpriteId[] = ["defaultWarrior", "neera", "voss", "salazar", "aldric", "malrec", "defaultLancer", "soldier", "brigand", "captain", "sorcerer", "horror", "Asherah", "pikeman", "wardog", "troll", "morvenian-wolf", "mordavian-wolf", "punisher", "theButcher", "birolho", "birolho2", "birolho3", "familiar", "familiar2", "familiar3", "swamp-blue-calf", "ancient-golem", "lancer", "sandoval", "kaelFinal", "kaelEarly", "conjurer", "cultist-v2", "archerRecruit", "mageRecruit", "healerRecruit"];

const LOAD_POOL = 8;
let loadActive = 0;
const loadWait: (() => void)[] = [];

function acquireLoad(): Promise<void> {
  if (loadActive < LOAD_POOL) {
    loadActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => loadWait.push(() => {
    loadActive++;
    resolve();
  }));
}

function releaseLoad(): void {
  loadActive--;
  const next = loadWait.shift();
  if (next) next();
}

function spriteFrameSrc(id: SpriteId, frame: string, cacheBust = ""): string {
  // Conjurer's active art is kept as a complete, source-preserved serial. Talk drives idle; the former Idle sheet drives casting.
  const directory = id === "conjurer" ? "conjurer/conjurer-complete-003" : id === "sandoval" ? "sandoval/sandoval-complete-001" : id === "kaelFinal" ? "Kael_Final/kael-final-002" : id === "kaelEarly" ? "kael" : id === "defaultWarrior" ? "kael-v2" : id;
  return `/game/sprites/${directory}/${frame}.png${cacheBust}`;
}
function loadImage(src: string): Promise<HTMLImageElement> {
  return acquireLoad().then(
    () =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        const fail = () => reject(new Error(`Falha ao carregar ${src}`));
        const t = window.setTimeout(() => {
          done();
          fail();
        }, 20000);
        const done = () => {
          window.clearTimeout(t);
          releaseLoad();
        };
        img.onload = () => {
          done();
          resolve(img);
        };
        img.onerror = () => {
          done();
          fail();
        };
        img.src = src;
      }),
  );
}

// Sprites cut as a 12-frame idle rather than the 4-frame default — the heroes, the two
// big horrors, and the creatures cut from reference video (familiar, familiar2, ancient
// golem). loadGameArt rejects on any missing file, so this set and what is on disk have to
// move together.
const HERO_IDLE = new Set<SpriteId>(["defaultWarrior", "neera", "voss", "salazar", "aldric", "defaultLancer", "horror", "Asherah", "familiar", "familiar2", "ancient-golem", "lancer", "sandoval", "kaelFinal", "kaelEarly", "conjurer", "malrec", "archerRecruit", "mageRecruit", "healerRecruit"]);

/** arrow-002.png is a moody product photo shot on black with no alpha channel; it was
 * originally drawn with a screen/lighter blend to fake-hide that background, which only
 * works when composited straight onto opaque battlefield pixels. renderUnitsAndOverlays
 * draws projectiles onto their own transparent per-frame canvas (see BattleCanvas), so
 * blending against nothing just paints a solid near-black square. Bake real alpha from
 * the image's own luminance once at load time so it composites correctly on any layer. */
function deriveAlphaFromBlack(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const c = canvas.getContext("2d")!;
  c.drawImage(img, 0, 0);
  const data = c.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    px[i + 3] = Math.max(px[i], px[i + 1], px[i + 2]);
  }
  c.putImageData(data, 0, 0);
  return canvas;
}
export async function loadGameArt(): Promise<GameArt> {
  const tiles = {} as Record<TerrainId, HTMLImageElement[]>;
  await Promise.all(
    TILES.map(async (id) => {
      const n = TILE_VARIANT_COUNT[id];
      tiles[id] = await Promise.all(Array.from({ length: n }, (_, i) => loadImage(tileVariantSrc(id, i))));
    }),
  );
  const decorations = {} as Record<string, HTMLImageElement>;
  await Promise.all(
    Object.keys(DECORATIONS).map(async (id) => {
      decorations[id] = await loadImage(decorationImage(id));
    }),
  );
  const sprites = {} as Record<SpriteId, HTMLImageElement[]>;
  const attacks: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  await Promise.all(
    SPRITES.map(async (id) => {
      const n = id === "conjurer" || id === "kaelFinal" || id === "aldric" || id === "cultist-v2" || id === "malrec" || id === "familiar3" ? 36 : id === "sandoval" || id === "mordavian-wolf" ? 8 : id === "birolho2" ? 18 : id === "birolho3" ? 12 : HERO_IDLE.has(id) ? 12 : 4;
      const cacheBust = id === "troll" ? "?v=11" : id === "Asherah" ? "?v=3" : id === "familiar" ? "?v=6" : id === "aldric" ? "?v=aldric-final-001" : id === "defaultLancer" ? "?v=sheet2" : id === "lancer" ? "?v=3" : id === "sandoval" ? "?v=sandoval-complete-001" : id === "kaelFinal" ? "?v=kael-final-002" : id === "kaelEarly" ? "?v=kael-early" : id === "defaultWarrior" ? "?v=kael-v2" : id === "conjurer" ? "?v=conjurer-complete-003" : "";
      sprites[id] = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          loadImage(spriteFrameSrc(id, id === "conjurer" ? `talk-${i + 1}` : `${i + 1}`, cacheBust)),
        ),
      );
    }),
  );
  // Attack cuts, per sprite: how many atk-*.png frames are on disk, and the cache-bust the
  // set was last republished under. attackPose spreads whatever count it finds across the
  // lunge/hit/recover stages, so a set only has to be listed here to animate.
  const ATTACK_FRAMES: Partial<Record<SpriteId, { n: number; bust: string }>> = {
    // The generic/default warrior look (CLASSES.swordsman's own sprite), its own distinct
    // on-disk cut (kael-v2 — an old internal folder name, kept as-is on disk) — the MC
    // himself is a different unit entirely and plays as kaelFinal instead.
    defaultWarrior: { n: 12, bust: "?v=kael-v2" },
    kaelEarly: { n: 12, bust: "?v=kael-early" },
    neera: { n: 4, bust: "" },
    voss: { n: 4, bust: "" },
    salazar: { n: 4, bust: "" },
    // Generic-enemy "alter" sprites (see the SpriteId comment in types.ts) — same file
    // shape as the hero folder they started as a copy of, since they're literally that
    // copy for now.
    archerRecruit: { n: 4, bust: "" },
    mageRecruit: { n: 4, bust: "" },
    healerRecruit: { n: 4, bust: "" },
    aldric: { n: 36, bust: "?v=aldric-final-001" },
    // Malrec's own personally-named slot, seeded from a clean copy of the finished
    // conjurer 36-frame sheet (see HERO_SPRITE_BY_NAME in engine.ts) — never the old
    // broken "malrec" sheet, which was permanently deleted.
    malrec: { n: 36, bust: "" },
    defaultLancer: { n: 5, bust: "?v=sheet2" },
    familiar: { n: 8, bust: "?v=6" },
    // Familiar 2 — the crouch/lunge strike cut from reference video (see CAST_FRAMES and
    // WALK_FRAMES below for its casting and walk cuts).
    familiar2: { n: 12, bust: "" },
    "ancient-golem": { n: 8, bust: "" },
    "morvenian-wolf": { n: 6, bust: "" },
    // Mordavian Wolf — the bigger cousin, sliced from its own reference sheet; the row
    // labeled "8 frames" only actually has 7 distinct poses (two columns share the "07" tag,
    // none reads "02"-"05" — a defect in that sheet's own generation, not a slicing choice).
    "mordavian-wolf": { n: 7, bust: "" },
    birolho: { n: 4, bust: "" },
    birolho2: { n: 4, bust: "" },
    punisher: { n: 4, bust: "" },
    // The Butcher — real 36-frame axe swing, a distinct unit/sprite from punisher/Carrasco
    // above (see WALK_FRAMES.theButcher below for the matching walk cut).
    theButcher: { n: 36, bust: "?v=the-butcher-001" },
    lancer: { n: 6, bust: "?v=3" },
    sandoval: { n: 6, bust: "?v=sandoval-complete-001" },
    kaelFinal: { n: 36, bust: "?v=kael-final-002" },
    conjurer: { n: 36, bust: "?v=conjurer-complete-003" },
    "cultist-v2": { n: 36, bust: "" },
    // Familiar 3's primary attack cut — see ATTACK2_FRAMES below for its alternate cut,
    // which Unit.idleAlt alternates into turn to turn (same flip as Malrec's idles2).
    familiar3: { n: 36, bust: "" },
  };
  await Promise.all(
    (Object.keys(ATTACK_FRAMES) as SpriteId[]).map(async (id) => {
      const { n, bust } = ATTACK_FRAMES[id]!;
      attacks[id] = await Promise.all(Array.from({ length: n }, (_, i) => loadImage(spriteFrameSrc(id, `atk-${i + 1}`, bust))));
    }),
  );
  // Cast pose: cast-*.png, same shape as the attack table — a sprite absent from here falls
  // back to its attacks cut (the melee swing) for a spell just like it always did before this
  // existed.
  const CAST_FRAMES: Partial<Record<SpriteId, { n: number; bust: string }>> = {
    birolho: { n: 3, bust: "" },
    birolho2: { n: 3, bust: "" },
    birolho3: { n: 18, bust: "" },
    // The spell cast intentionally uses the former Idle sheet; ATT remains the physical attack.
    conjurer: { n: 36, bust: "?v=conjurer-complete-003" },
    // Malrec's own cast-*.png — a copy of conjurer's same dedicated cast sequence.
    malrec: { n: 36, bust: "" },
    // Aldric's dedicated skill pose — plays only for his spell-typed pike skills (Piercing
    // Thrust, Sweep, ...), never for a plain attack, which stays on the ATT cut.
    aldric: { n: 36, bust: "?v=aldric-final-001" },
    "cultist-v2": { n: 36, bust: "" },
    // Familiar 2's real rear-up/charge/beam-release windup — a distinct animation from its
    // ATT cut (the crouch/lunge), not a fallback.
    familiar2: { n: 24, bust: "" },
    // Familiar 3's spellcasting windup (cast-*.png) — plays for its Fireball cast only
    // (attackPose falls back to `attacks` for a plain melee swing); see ATTACK_FRAMES/
    // ATTACK2_FRAMES above for its two melee attack cuts.
    familiar3: { n: 36, bust: "" },
  };
  // Familiar 3's second, distinct attack cut (atk2-*.png) — the first case of a class having
  // more than one attack cut, same "second pool, same idleAlt flip" shape as Malrec's idles2
  // but for the attack pool instead of idle (see GameArt.attacks2's doc comment).
  const ATTACK2_FRAMES: Partial<Record<SpriteId, { n: number; bust: string }>> = {
    familiar3: { n: 36, bust: "" },
  };
  const attacks2: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  await Promise.all(
    (Object.keys(ATTACK2_FRAMES) as SpriteId[]).map(async (id) => {
      const { n, bust } = ATTACK2_FRAMES[id]!;
      attacks2[id] = await Promise.all(Array.from({ length: n }, (_, i) => loadImage(spriteFrameSrc(id, `atk2-${i + 1}`, bust))));
    }),
  );
  const casts: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  await Promise.all(
    (Object.keys(CAST_FRAMES) as SpriteId[]).map(async (id) => {
      const { n, bust } = CAST_FRAMES[id]!;
      casts[id] = await Promise.all(Array.from({ length: n }, (_, i) => loadImage(spriteFrameSrc(id, id === "conjurer" ? `${i + 1}` : `cast-${i + 1}`, bust))));
    }),
  );
  // Left-facing counterpart to a handful of the CAST_FRAMES cuts above — same idea as
  // attacksLeft/walksLeft: a sprite here skips the mirrored flip and plays this set instead
  // when facing === -1.
  const CAST_DIR_LEFT: SpriteId[] = ["aldric"];
  const castsLeft: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  await Promise.all(
    CAST_DIR_LEFT.map(async (id) => {
      const { n, bust } = CAST_FRAMES[id]!;
      castsLeft[id] = await Promise.all(Array.from({ length: n }, (_, i) => loadImage(spriteFrameSrc(id, `cast-left-${i + 1}`, bust))));
    }),
  );
  // Counter pose: counter-*.png, same shape as the attack table — a sprite absent from here
  // falls back to its attacks cut (the same swing used for a normal attack) for the
  // defender's counter stages, same as every sprite did before this existed.
  const COUNTER_FRAMES: Partial<Record<SpriteId, { n: number; bust: string }>> = {
    theButcher: { n: 36, bust: "?v=the-butcher-counter-001" },
  };
  const counters: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  await Promise.all(
    (Object.keys(COUNTER_FRAMES) as SpriteId[]).map(async (id) => {
      const { n, bust } = COUNTER_FRAMES[id]!;
      counters[id] = await Promise.all(Array.from({ length: n }, (_, i) => loadImage(spriteFrameSrc(id, `counter-${i + 1}`, bust))));
    }),
  );
  // No sprite has a dedicated left-facing counter cut yet — every counters entry mirrors
  // via the regular flip, same as attacksLeft does for a sprite absent from that table.
  const countersLeft: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  // Walk cycles: move-*.png, same shape as the attack table. A sprite absent from here has
  // no walk cut and falls back to its idle loop played faster, as every sprite used to.
  const WALK_FRAMES: Partial<Record<SpriteId, { n: number; bust: string }>> = {
    familiar: { n: 8, bust: "?v=6" },
    // Right-facing cut; see the dedicated walksLeft.familiar2 load below for its own
    // authored left-facing cut (real distinct footage, not the CSS mirror every other
    // sprite absent from walksLeft falls back to).
    familiar2: { n: 12, bust: "" },
    "ancient-golem": { n: 8, bust: "" },
    aldric: { n: 36, bust: "?v=aldric-final-001" },
    defaultLancer: { n: 6, bust: "?v=sheet2" },
    lancer: { n: 6, bust: "?v=3" },
    sandoval: { n: 6, bust: "?v=sandoval-complete-001" },
    // One authored right-facing walk. The renderer mirrors it for left-facing movement.
    // defaultWarrior (the generic/default warrior look) has no move-*.png cut of its own —
    // it falls back to its idle loop played faster, like every sprite absent from this table.
    kaelFinal: { n: 36, bust: "?v=kael-final-002" },
    conjurer: { n: 36, bust: "?v=conjurer-complete-003" },
    // Real authored Walk Right footage replaced the old cut here — bumped so browsers
    // holding the old move-*.png in cache actually fetch the new art (the old cut lives on
    // as idle2-*.png, his alternate-turn idle; see idles2.malrec above). Mirrored via the
    // regular CSS flip for left-facing movement, same as any sprite with one authored
    // direction — see the walksLeft.malrec comment below for why.
    malrec: { n: 36, bust: "?v=malrec-walk-002" },
    birolho3: { n: 12, bust: "" },
    // Right-facing cut; see the dedicated walksLeft.theButcher load below for its own
    // authored left-facing cut (not the CSS mirror every other sprite here falls back to).
    theButcher: { n: 36, bust: "?v=the-butcher-001" },
    // Right-facing cut; see the dedicated walksLeft["cultist-v2"] load below.
    "cultist-v2": { n: 36, bust: "" },
    familiar3: { n: 36, bust: "" },
    // Right-facing cut, sliced from the Mordavian Puppy reference sheet's WALK RIGHT row;
    // see the dedicated walksLeft["morvenian-wolf"] load below for its own authored
    // left-facing cut (real distinct footage, 7 frames vs this row's 6 — not the CSS mirror
    // every other sprite absent from walksLeft falls back to).
    "morvenian-wolf": { n: 6, bust: "" },
    // Mordavian Wolf — one authored cut (its sheet has no separate left row like the
    // Puppy's); the renderer mirrors it for left-facing movement, same as most sprites here.
    "mordavian-wolf": { n: 8, bust: "" },
  };
  const walks: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  await Promise.all(
    (Object.keys(WALK_FRAMES) as SpriteId[]).map(async (id) => {
      const { n, bust } = WALK_FRAMES[id]!;
      walks[id] = await Promise.all(Array.from({ length: n }, (_, i) => loadImage(spriteFrameSrc(id, `move-${i + 1}`, bust))));
    }),
  );
  const walksLeft: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  const attacksLeft: Partial<Record<SpriteId, HTMLImageElement[]>> = {};
  const DIR_LEFT: SpriteId[] = ["aldric", "defaultLancer", "lancer", "sandoval"];
  await Promise.all(
    DIR_LEFT.map(async (id) => {
      const walkN = WALK_FRAMES[id]?.n ?? 6;
      const atkN = ATTACK_FRAMES[id]?.n ?? 5;
      const bust = id === "lancer" ? "?v=3" : id === "sandoval" ? "?v=sandoval-complete-001" : id === "aldric" ? "?v=aldric-final-001" : "?v=sheet2";
      walksLeft[id] = await Promise.all(Array.from({ length: walkN }, (_, i) => loadImage(spriteFrameSrc(id, `move-left-${i + 1}`, bust))));
      attacksLeft[id] = await Promise.all(Array.from({ length: atkN }, (_, i) => loadImage(spriteFrameSrc(id, `atk-left-${i + 1}`, bust))));
    }),
  );
  // The Butcher has its own authored left-facing walk cut, but no dedicated left-facing
  // attack cut — so it only gets a walksLeft entry (loaded on its own, not through
  // DIR_LEFT, which always loads both together). Its attack keeps using the CSS
  // mirror-flip of the right-facing attacks pool when facing left (see the render loop's
  // dirAction). Distinct from "punisher"/Carrasco, which has no walk cut of its own at all.
  walksLeft.theButcher = await Promise.all(
    Array.from({ length: WALK_FRAMES.theButcher!.n }, (_, i) => loadImage(spriteFrameSrc("theButcher", `move-left-${i + 1}`, WALK_FRAMES.theButcher!.bust))),
  );
  // Cultist V2 has its own authored left-facing walk cut but no dedicated left-facing attack
  // cut (only one Attack sheet was supplied) — same shape as theButcher above: its own
  // standalone walksLeft load, attack keeps mirroring the right-facing pool when facing left.
  walksLeft["cultist-v2"] = await Promise.all(
    Array.from({ length: WALK_FRAMES["cultist-v2"]!.n }, (_, i) => loadImage(spriteFrameSrc("cultist-v2", `move-left-${i + 1}`, WALK_FRAMES["cultist-v2"]!.bust))),
  );
  // Familiar 2 has real, distinct left-facing walk footage (not a mirrored gait) — same
  // shape as theButcher/cultist-v2 above: its own standalone walksLeft load, attack keeps
  // mirroring the right-facing pool when facing left.
  walksLeft.familiar2 = await Promise.all(
    Array.from({ length: WALK_FRAMES.familiar2!.n }, (_, i) => loadImage(spriteFrameSrc("familiar2", `move-left-${i + 1}`, WALK_FRAMES.familiar2!.bust))),
  );
  // Mordavian Puppy has real, distinct left-facing walk footage sliced from the same
  // reference sheet's WALK LEFT row — 7 frames there vs 6 in WALK_FRAMES["morvenian-wolf"]'s
  // right-facing count above, so this can't reuse that n like familiar2/theButcher/cultist-v2
  // do; it's its own standalone count.
  walksLeft["morvenian-wolf"] = await Promise.all(
    Array.from({ length: 7 }, (_, i) => loadImage(spriteFrameSrc("morvenian-wolf", `move-left-${i + 1}`, ""))),
  );
  // Malrec's own "Walk Left" export turned out not to be mirrored footage at all — laid
  // frame-by-frame next to "Walk Right", both face/stride the same screen direction. The
  // sliced move-left-*.png frames are left on disk but deliberately unused: no walksLeft
  // entry here means the render loop's usual CSS mirror-flip of `walks.malrec` handles
  // left-facing movement instead, same as every sprite with only one authored direction.
  const impact = await Promise.all([1, 2, 3, 4].map((n) => loadImage(`/game/fx/impact-${n}.png`)));
  // v2: real alpha-cutout comet art (ball + trailing wisps), replacing the old flattened
  // black-background v1 that only ever worked by additive-blending the black away.
  const fireballCore = await loadImage("/game/fx/fireball-core-v2.png?v=1");
  const causticVenomCore = await loadImage("/game/fx/caustic-venom-core-v2.png?v=1");
  const arrowCore = deriveAlphaFromBlack(await loadImage("/game/fx/arrow-002.png?v=1"));
  const lightningCores = await Promise.all([
    loadImage("/game/fx/lightning-core-v1.png?v=1"),
    loadImage("/game/fx/lightning-core-v2.png?v=1"),
    loadImage("/game/fx/lightning-core-v3.png?v=1"),
  ]);
  const webfloor = await loadImage("/game/fx/webfloor.png?v=1");
  const backdrops: Record<string, HTMLImageElement> = {
    profundezas: await loadImage("/game/assets/profundezas-bg.jpg?v=2"),
    thebridge: await loadImage("/game/assets/thebridge-bg.jpg?v=1"),
    "wisp-forest": await loadImage("/game/assets/wisp-forest-bg.jpg"),
    "random-encounter-1": await loadImage("/game/assets/random-encounter-1-bg.jpg"),
    "random-encounter-2": await loadImage("/game/assets/random-encounter-2-bg.jpg"),
    "random-encounter-4": await loadImage("/game/assets/random-encounter-4-bg.jpg"),
    "random-encounter-5": await loadImage("/game/assets/random-encounter-5-bg.jpg"),
    "random-encounter-8": await loadImage("/game/assets/random-encounter-8-bg.jpg"),
    // O Vau's campaign battlefield has its own ash-river vista. Keep Vau Raso on the earlier
    // backdrop below: its road encounter is a separate place and should not inherit this scene.
    vau: await loadImage("/game/assets/vau-1-bg.jpg"),
    "random-encounter-6": await loadImage("/game/assets/vau-bg.jpg"),
    aldeia: await loadImage("/game/assets/aldeia-bg.jpg"),
    bosque: await loadImage("/game/assets/bosque-bg.jpg"),
  };
  const idles: Partial<Record<SpriteId, HTMLImageElement[]>> = {
    // defaultWarrior (the generic/default warrior look) reads its own kael-v2 stand cut;
    // kaelEarly keeps the original kael-folder 36-frame stand cut. See CLASSES.swordsman vs
    // CLASSES.kaelEarly.
    defaultWarrior: await Promise.all(Array.from({ length: 12 }, (_, i) => loadImage(`/game/sprites/kael-v2/stand-${i + 1}.png?v=kael-v2`))),
    kaelEarly: await Promise.all(Array.from({ length: 36 }, (_, i) => loadImage(`/game/sprites/kael/stand-${i + 1}.png?v=kael-early`))),
  };
  // Malrec's second idle loop: his original walk-right cut, kept on disk as idle2-*.png once
  // real Walk Right/Left footage replaced move-*.png as his actual walk (see WALK_FRAMES and
  // walksLeft.malrec above). Unit.idleAlt flips between this and his regular stand loop once
  // per his own turn (see beginUnitTurn), so he visibly alternates stance turn to turn.
  const idles2: Partial<Record<SpriteId, HTMLImageElement[]>> = {
    malrec: await Promise.all(Array.from({ length: 36 }, (_, i) => loadImage(`/game/sprites/malrec/idle2-${i + 1}.png`))),
  };
  const walkDirs: GameArt["walkDirs"] = {
    // kael-v2 has no walk-front/back/side cut, so defaultWarrior has no walkDirs entry — it
    // falls back to its idle loop while moving, like any sprite absent from this table.
    kaelEarly: {
      front: await loadImage("/game/sprites/kael/walk-front.png?v=kael-early"),
      back: await loadImage("/game/sprites/kael/walk-back.png?v=kael-early"),
      side: await loadImage("/game/sprites/kael/walk-side.png?v=kael-early"),
    },
    // No side-on art for either — the idle/front frame stands in, same as it already does for
    // any sprite with no walkDirs entry at all, so a purely sideways step doesn't visibly swap.
    birolho: {
      front: await loadImage("/game/sprites/birolho/1.png"),
      back: await loadImage("/game/sprites/birolho/back.png"),
      side: await loadImage("/game/sprites/birolho/1.png"),
    },
    birolho2: {
      front: await loadImage("/game/sprites/birolho2/1.png"),
      back: await loadImage("/game/sprites/birolho2/back.png"),
      side: await loadImage("/game/sprites/birolho2/1.png"),
    },
    punisher: {
      front: await loadImage("/game/sprites/punisher/front.png"),
      back: await loadImage("/game/sprites/punisher/back.png"),
      side: await loadImage("/game/sprites/punisher/front.png"),
    },
    // theButcher has no walkDirs entry: it has real walk-cycle frames instead (see
    // WALK_FRAMES.theButcher / walksLeft.theButcher above) — walkDirs would otherwise take
    // priority over them while moving (see the render loop's img lookup), leaving that
    // animation dead code.
  };
  return { tiles, decorations, sprites, attacks, attacks2, attacksLeft, casts, castsLeft, counters, countersLeft, walks, walksLeft, idles, idles2, walkDirs, impact, fireballCore, causticVenomCore, arrowCore, lightningCores, webfloor, backdrops };
}
