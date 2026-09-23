/** MILESTONE 1 (done) — terrain, ground/behind-layer decorations, and animated unit sprites all
 * render through a real Three.js scene instead of the Canvas2D-shim WebGL renderer, as the first
 * slice of migrating the battlefield to a genuine spatial rendering environment (see the
 * architecture note below). "Front"-layer/foreground props still render through the existing
 * Canvas2D-shim units canvas, unchanged, stacked on top — this renderer replaces the
 * ground/terrain canvas and everything meant to draw under a unit, never anything meant to draw
 * in front of one (see BattleCanvas.tsx).
 *
 * MILESTONE 2 (done) — real DirectionalLight + AmbientLight-ish HemisphereLight, and real cast
 * shadows from invisible per-unit/per-decoration boxes with a synthetic elevation (see
 * shadowCasterMaterial/updateSun and THREEJS_MILESTONE2_HANDOFF.md).
 *
 * MILESTONE 3 (in progress) — real world-space ground mist + GPU-instanced drift particles (see
 * ThreeAtmosphere.ts, which owns this entirely — this file only constructs it, syncs it once per
 * frame, and disposes it). No bloom/post-processing yet, that's Milestone 4.
 *
 * ARCHITECTURE: every tile mesh is built ONCE at its fixed WORLD position (the same formula
 * BattleEngine.effectAnchor already uses for worldX/worldY) and never moves again. Camera
 * panning moves the CAMERA, not the tiles — a real spatial scene, not screen-space coordinates
 * recomputed every frame. This is what makes later milestones (real DirectionalLight/shadows,
 * world-space fog, depth-sorted particles) possible without another rewrite: every tile has an
 * actual, stable position in a 3D world a light or a fog volume can reason about.
 *
 * COORDINATE CONVENTION: the orthographic camera's frustum is a STANDARD (left=0, right=cssW,
 * top=cssH, bottom=0) one — top > bottom, the normal orientation. An orthographic camera with
 * an inverted frustum (top < bottom), which is what a naive "world Y increases down the screen"
 * port of BattleEngine's cx/cy convention would want, renders nothing at all in this Three.js
 * version (confirmed empirically: identical scene/camera/mesh renders correctly with a standard
 * frustum and renders nothing with an inverted one, regardless of camera or mesh position —
 * some part of the projection/clipping pipeline silently assumes top > bottom). So the Y-flip
 * BattleEngine's convention needs happens elsewhere instead: every mesh is placed at Y = -wy
 * (see hexWorld) rather than +wy, and the camera's own Y position is offset by -camY - cssH to
 * match. Both are derived once, together, in render()/ensureBuilt() — verified numerically
 * against BattleEngine's own cx/cy formula, not just visually. This still lets every other
 * system (mouse picking via BattleEngine.cellAt, hover/selection highlighting, unit sprites on
 * the Canvas2D-shim units canvas, panBy/zoom) keep working completely unchanged: they all
 * operate in CSS-pixel space, which this renderer's on-screen RESULT still matches exactly —
 * only the intermediate Three.js coordinates carry the flip, nothing outside this file does. */

import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { BattleEngine } from "../../engine";
import { BIG_HOUSE_DECOR_IDS, CHEST_DECOR_IDS, DECORATIONS, HOUSE_DECOR_IDS, TERRAIN, decorationFacing, decorationImage, placedFootprint } from "../../data";
import { tileAt } from "../../pathfinding";
import type { DecorationDef, DecorationPlacement, TerrainId } from "../../types";
import { ThreeAtmosphere } from "./ThreeAtmosphere";
import { getDevGfx } from "./devGfx";

const SQRT3 = Math.sqrt(3);
/** Must match BattleEngine's private boardPad() (tile * 2.4) — duplicated here rather than
 * exposed because it's one number, not worth widening engine.ts's public surface for. */
const BOARD_PAD_MUL = 2.4;

/** Fraction of a unit/decoration's drawn height used as its invisible shadow-casting elevation.
 * The visible art stays flat billboards (see module comment) — this is a synthetic "how tall
 * would this actually stand" number for the light alone, not a real 3D height. Kept modest on
 * purpose (see the AtmosphereFX caution in THREEJS_MILESTONE2_HANDOFF.md) — tune after checking
 * screenshots, not blindly. */
const UNIT_SHADOW_HEIGHT_SCALE = 0.85;
const DECOR_SHADOW_HEIGHT_SCALE = 0.9;

/** How far BELOW the ground plane (z=0) every standing shadow-caster's base now extends, world
 * units. The caster's base sits exactly AT z=0 — coplanar with the ground mesh it casts onto —
 * which is the textbook cause of peter-panning (the shadow test can't reliably tell which surface
 * is in front right at that shared boundary, so the shadow reads as detached from the caster's own
 * base). This was already solved once for the old box caster (see git history) by sinking its base
 * slightly below ground instead of touching it exactly, then removed when the caster became a
 * standing silhouette plane on the (wrong) assumption a flat plane wouldn't have the same
 * coplanarity problem — it does, since its base still touches z=0 either way. Only the caster's
 * own base moves; its top (what actually governs the shadow's shape/reach) stays exactly where it
 * was. Not a bias fix — this is geometry-only, per direct instruction to leave `bias`/`normalBias`
 * alone. Units and decorations get their OWN value each (not one shared constant) — sharing one
 * and bumping it for units visibly broke decorations, since they don't have the same proportions. */
const UNIT_SHADOW_GROUND_INSET = 3;
const DECOR_SHADOW_GROUND_INSET = 3;

/** Direction the sun travels (not where it sits) — X/Y chosen so a shadow cast from height H
 * lands at world offset (0.6H, -0.8H), i.e. the exact same (0.6, 0.8) screen-space direction
 * (down-right; world Y is negated, see module comment) the old fake Canvas2D ellipse shadow
 * already used (see engine.ts's shadowDirX/shadowDirY) — so the sun's on-screen angle doesn't
 * visibly change when the fake shadow is eventually retired. Z=-1 (travelling toward -Z, i.e.
 * from the elevated shadow-caster boxes down onto the z=0 ground plane) derived alongside that:
 * a point at height H casts onto z=0 at (x - H*dir.x/dir.z, y - H*dir.y/dir.z) — solving for the
 * desired (0.6H, -0.8H) offset with dir.z=-1 gives dir.x=0.6, dir.y=-0.8 exactly. */
const SUN_DIRECTION = new THREE.Vector3(0.6, -0.8, -1).normalize();
const SUN_DISTANCE = 2000;

/** Default sun/ambient intensities, used whenever a mission doesn't set its own
 * `sunIntensity`/`ambientIntensity` (see types.ts) — also what the Map Editor's "Iluminação"
 * sliders default a new/untouched map to (see GameApp.tsx), so the editor's default and the
 * renderer's fallback can never drift apart. Set to match the exact values the user tuned by
 * hand on "O Vau" (saved as vau016.json) and asked to be the standard daytime look for every
 * outdoor mission ("the basic setup for every daytime map... everything but caves"). */
export const DEFAULT_SUN_INTENSITY = 5;
export const DEFAULT_AMBIENT_INTENSITY = 2;
/** "indoor" environment preset (see Mission.environment): a raking outdoor sun makes no sense
 * inside a building, so indoor missions get a much weaker directional light and a much stronger
 * ambient fill instead — flatter, but not fully unlit. Only applied when the mission doesn't
 * also set an explicit sunIntensity/ambientIntensity of its own. */
const INDOOR_SUN_INTENSITY = 0.35;
const INDOOR_AMBIENT_INTENSITY = 0.65;

/** MILESTONE 4 — real post-processing (UnrealBloomPass on the actual rendered scene, via
 * EffectComposer), not a CSS/canvas filter pretending to be one. Matches the user's own tuned
 * "O Vau" setup (vau016.json), the standard daytime default — see DEFAULT_SUN_INTENSITY's
 * comment. Bloom now applies to the whole scene (see render()'s own comment), not just wisp
 * embers, so a high intensity CAN wash out bright ground art too — that's expected now. */
export const DEFAULT_BLOOM_INTENSITY = 0.9;
const BLOOM_RADIUS = 0.4;
/** Full-scene bloom (see render()'s own comment) needs a threshold well above the old
 * selective-only 0.2 — that value only ever had to separate wisp embers from a pass that was
 * otherwise pure black. Against the REAL rendered scene, 0.2 would catch huge swaths of
 * ordinary lit ground art and wash the whole board out in a permanent haze. 0.75 keeps it to
 * genuine highlights: sun glints, the active-turn glow, bright embers/holy/fire FX. */
const BLOOM_THRESHOLD = 0.75;

/** Same formula as BattleEngine.effectAnchor's worldX/worldY — a hex's position independent of
 * camera pan. Duplicated (not imported) because effectAnchor is keyed to the engine's live
 * layout.tile, whereas this renderer needs it before/without going through a render call. */
function hexWorld(col: number, row: number, tile: number): { wx: number; wy: number } {
  return {
    wx: tile * SQRT3 * (col + 0.5 * (row & 1) + 0.5),
    wy: tile * BOARD_PAD_MUL + tile * (1.5 * row + 1),
  };
}

/** Pointy-top hex fan (center + 6 rim vertices + 6 triangles), radius 0.5 so scaling by
 * tile*2 matches Canvas2D's hexPath(ctx, cx, cy, tile*1.0) exactly — same vertex angles
 * (60*i-30 degrees), Y negated to compensate for local Y=+0.5 landing at the screen TOP in
 * this renderer (Canvas2D's Y-down convention has that same vertex angle read as "below
 * center"; see the module comment on the Y-flip). UVs use the same 0..1 mapping a plain
 * PlaneGeometry uses (localX+0.5, localY+0.5, on the SAME already-flipped local Y), so a
 * texture drawn as if filling the full tile*2 square shows through only inside the hex
 * outline — identical to Canvas2D's clip()-then-drawImage. */
function buildHexGeometry(): THREE.BufferGeometry {
  const positions: number[] = [0, 0, 0];
  const uvs: number[] = [0.5, 0.5];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    const x = Math.cos(a) * 0.5;
    const y = -Math.sin(a) * 0.5;
    positions.push(x, y, 0);
    uvs.push(x + 0.5, y + 0.5);
  }
  // Winding order matters: (0, i, i%6+1) comes out clockwise-from-+Z here (culled by the
  // default FrontSide material, since this camera looks down -Z from +Z) — reversed to
  // (0, i%6+1, i) so the hex actually faces the camera.
  const indices: number[] = [];
  for (let i = 1; i <= 6; i++) indices.push(0, (i % 6) + 1, i);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  // Needed for MILESTONE 2's MeshLambertMaterial (unlit MeshBasicMaterial never reads normals) —
  // every vertex lies in the same z=0 plane facing the camera, so this is just (0,0,1) everywhere.
  geo.computeVertexNormals();
  return geo;
}

interface TileMeshEntry {
  mesh: THREE.Mesh;
  id: TerrainId;
  variant: number;
  rot: number;
}

/** Ported verbatim from BattleEngine.drawDecorations' sizing math (see that method's own
 * comments for the reasoning behind each special case) — pure numbers, no canvas calls, so
 * there was nothing renderer-specific to translate. Kept in exact sync with engine.ts by hand;
 * a mismatch here means a prop is sized differently on the two renderers, not a crash, so it
 * won't show up as a type error — check against drawDecorations if a prop looks off. */
function decorSize(id: string, def: DecorationDef, tile: number): { w: number; h: number; dy: number } {
  let minDx = 0;
  let maxDx = 0;
  let minDy = 0;
  let maxDy = 0;
  for (const { dx, dy } of def.footprint) {
    minDx = Math.min(minDx, dx);
    maxDx = Math.max(maxDx, dx);
    minDy = Math.min(minDy, dy);
    maxDy = Math.max(maxDy, dy);
  }
  const one = def.footprint.length === 1;
  const item = CHEST_DECOR_IDS.has(id);
  const tree = id === "dead-tree";
  const log = id === "fallen-log";
  const wall = id === "barricade" || id === "barricade-2";
  const anyHouse = HOUSE_DECOR_IDS.has(id) || BIG_HOUSE_DECOR_IDS.has(id);
  const w = tree
    ? tile * 1.28
    : log
      ? tile * SQRT3 * 2.05
      : wall
        ? tile * 1.42
        : anyHouse
          ? tile * 1.45 * 3
          : item
            ? tile * 0.92
            : one
              ? tile * 1.55
              : tile * SQRT3 * (maxDx - minDx + 1.7);
  const baseH = tree
    ? tile * 2.55
    : log
      ? tile * 0.82
      : wall
        ? tile * 1.18
        : anyHouse
          ? tile * 1.58 * 3
          : item
            ? tile * 0.72
            : one
              ? tile * 1.65
              : tile * (1.5 * (maxDy - minDy) + 2.3);
  const h = baseH * (def.heightScale ?? 1);
  const dy = (tree ? -tile * 0.55 : wall ? -tile * 0.12 : anyHouse ? -tile * 0.28 * 3 : item ? tile * 0.08 : 0) - (h - baseH) * 0.42;
  return { w, h, dy };
}

/** PCF filter radius (shadow-map texels) — 1 is Three's default hard-ish edge; the Dev Controls
 * "soft shadows" toggle raises it. This Three.js version's PCF path samples a 5-tap Vogel disk
 * scaled by this radius (see shadowmap_pars_fragment), so it softens without costing more taps. */
const SHADOW_RADIUS_HARD = 1;
const SHADOW_RADIUS_SOFT = 4;

/** Contact-shadow footprint, relative to the unit's drawn sprite width: wider than tall, a
 * stance shape rather than a circle. */
const CONTACT_SHADOW_W = 0.6;
const CONTACT_SHADOW_H = 0.24;
const CONTACT_SHADOW_OPACITY = 0.7;

/** Soft dark radial gradient shared by every unit's contact shadow — the same CanvasTexture
 * technique activeTurnShadowCatcher already uses (proven to render in this renderer). A custom
 * ShaderMaterial computing the falloff from UV was tried first and silently drew nothing here,
 * even at 3x size / opacity 1, while a plain MeshBasicMaterial on the same mesh did. */
function makeContactShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(20,16,12,1)");
  g.addColorStop(0.45, "rgba(20,16,12,0.6)");
  g.addColorStop(1, "rgba(20,16,12,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

interface DecorMeshEntry {
  mesh: THREE.Mesh;
  placement: DecorationPlacement;
  /** Same quadGeo + alpha-tested copy of the prop's own art (colorWrite off, see
   * decorShadowMaterialFor) that casts this prop's real shadow as its own silhouette, not a box. */
  shadowMesh: THREE.Mesh;
}

interface UnitMeshEntry {
  mesh: THREE.Mesh;
  /** Owned (not shared) per unit — see unitTexCache's comment on why opacity needs this. */
  material: THREE.MeshBasicMaterial;
  img: HTMLImageElement | null;
  /** Same quadGeo + alpha-tested copy of the unit's own sprite (colorWrite off) that casts this
   * unit's real shadow as its own silhouette, not a box — see shadowMaterial's own comment. */
  shadowMesh: THREE.Mesh;
  /** Owned per unit, same reasoning as `material` — swapped in step with entry.img/material.map
   * whenever the unit's current sprite frame changes, so the shadow always matches the current
   * pose instead of freezing on whatever frame first built this entry. */
  shadowMaterial: THREE.MeshBasicMaterial;
  /** Dev Controls "contact shadows" footprint — owned per unit (its opacity tracks this unit's
   * own fade/lift); the gradient texture itself is shared (contactShadowTexture). */
  contactMesh: THREE.Mesh;
  contactMaterial: THREE.MeshBasicMaterial;
}

export class ThreeBattleRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private tileGroup = new THREE.Group();
  private tileMeshes = new Map<number, TileMeshEntry>();
  // A camera-locked, cover-cropped copy of BattleEngine.renderGround's painted backdrop.
  // The legacy 2D path had this from day one; keeping it here prevents WebGL missions from
  // silently dropping any mission-specific background artwork.
  private backdropGeometry = new THREE.PlaneGeometry(1, 1);
  private backdropMaterial = new THREE.MeshBasicMaterial({ color: 0x949494, depthWrite: false, depthTest: false });
  private backdropMesh = new THREE.Mesh(this.backdropGeometry, this.backdropMaterial);
  private backdropTexture: THREE.Texture | null = null;
  private backdropImage: HTMLImageElement | null = null;
  // MeshLambertMaterial (not MeshBasicMaterial) — MILESTONE 2 terrain needs to actually receive
  // light/shadow. Decor and unit sprites deliberately stay MeshBasicMaterial (unlit) below, so
  // their art is untouched by this — only the ground gets the uniform lit tint (see the
  // architecture note in THREEJS_MILESTONE2_HANDOFF.md on why a flat scene can only tint, not
  // per-object shade).
  private materialCache = new Map<string, THREE.MeshLambertMaterial>();
  private fallbackMaterial = new THREE.MeshLambertMaterial({ color: 0x1e1b18 });
  private hexGeo = buildHexGeometry();
  private builtCols = -1;
  private builtRows = -1;
  private builtMissionId = "";
  private builtTile = -1;

  // MILESTONE 2 — lighting/shadows. hemiLight is a soft sky/ground fill so unlit-facing surfaces
  // don't go fully black (a single DirectionalLight alone would do that — see handoff doc);
  // sunLight is the one real shadow-casting light, aimed by updateSun() every frame to track the
  // camera (see SUN_DIRECTION's comment for why its direction is fixed). Shadow casters (units,
  // decorations) live on shadowCasterGroup — visible=true (required: WebGLShadowMap skips
  // object.visible===false entirely, so this can't be used to hide them). Each caster is now the
  // unit/prop's own alpha-tested art (colorWrite off — see decorShadowMaterialFor's/the per-unit
  // shadowMaterial's own comments for how invisibility in the normal pass is achieved) rather than
  // an invisible box, so the cast shadow matches the real silhouette instead of a rectangle.
  // Intensity args here are placeholders — the constructor immediately overrides both from
  // Mission.sunIntensity/ambientIntensity (or DEFAULT_SUN_INTENSITY/DEFAULT_AMBIENT_INTENSITY),
  // see that assignment's own comment.
  private hemiLight = new THREE.HemisphereLight(0xfff2df, 0x14110d, 0.45);
  private sunLight = new THREE.DirectionalLight(0xfff0d6, 1.8);
  private shadowCasterGroup = new THREE.Group();
  private lastShadowFrustumW = -1;
  private lastShadowFrustumH = -1;

  // Ground/behind-layer decorations only (trees, houses, rubble, ...) — see ensureDecorBuilt's
  // comment for why "front"-layer/foreground props stay on the existing Canvas2D-shim units
  // canvas instead of moving here.
  private quadGeo = new THREE.PlaneGeometry(1, 1);
  private decorGroup = new THREE.Group();
  private decorMatCache = new Map<string, THREE.MeshBasicMaterial>();
  // Shadow-only twin of decorMatCache — same cached texture, but alphaTest instead of plain alpha
  // blending (shadow depth passes need a hard cutout, not a blend) and colorWrite/depthWrite off
  // (see decorShadowMaterialFor's own comment), so it can't just reuse the visible material.
  private decorShadowMatCache = new Map<string, THREE.MeshBasicMaterial>();
  private decorEntries: DecorMeshEntry[] = [];
  private builtDecorKey = "";

  // Movement/attack/spell-range highlight + the active-turn ring (see
  // BattleEngine.boardOverlayLayers/activeTurnHighlight) — real world-space hex meshes at
  // z=0.5, between flat terrain (z=0, opaque, drawn first) and decorations (z=1, transparent).
  // Three draws transparent objects back-to-front by camera distance regardless of draw order,
  // so this lands the highlight visually ABOVE terrain but BELOW decorations and units (z=2+)
  // for free, the same depth trick tiles/decor/units already rely on — a blocking house or a
  // unit standing on a highlighted hex always stays legible instead of the highlight's tint
  // painting over it. Pooled rather than rebuilt (see syncOverlay): the highlighted set rarely
  // changes frame to frame, only its glow pulse does, well below this — which skips the pulse
  // entirely and just uses each layer's flat fill alpha (see boardOverlayLayers' own comment on
  // why that's the part that matters, not the canvas-only shadowBlur halo).
  private overlayGroup = new THREE.Group();
  private overlayMatCache = new Map<string, THREE.MeshBasicMaterial>();
  private overlayMeshPool: THREE.Mesh[] = [];
  private overlayGlowGroup = new THREE.Group();
  private overlayGlowPool: THREE.Sprite[] = [];
  // The old 2D marker used Canvas shadowBlur, which has a broad soft falloff rather than a
  // flat, expanding polygon. This sprite is that same falloff in world space, so WebGL keeps
  // the familiar 2D read while still sitting under units and props.
  private activeTurnGlowTexture: THREE.CanvasTexture;
  private activeTurnGlowMaterial: THREE.SpriteMaterial;
  private activeTurnGlow: THREE.Sprite;

  // ADDITIVE ONLY — does not read from or modify activeTurnGlow/place()'s flat hex above in any
  // way, per direct instruction never to touch that system again. THREE.ShadowMaterial renders as
  // fully transparent everywhere except where a real shadow actually falls (it's the stock
  // Three.js "shadow catcher" material, built for exactly this: compositing a real shadow onto
  // something else without otherwise altering it). Drawn at a higher z than both the flat hex
  // (0.5) and the glow sprite (0.45), so on the one tile that's already fully opaque gold, the
  // active unit's own real cast shadow can still show through on top of it — the hex's own color/
  // size/opacity/pulse timing are never read or written here.
  // ADDITIVE ONLY — does not read from or modify activeTurnGlow/place()'s flat hex above in any
  // way, per direct instruction never to touch that system again. A direct dark radial sprite
  // anchored at the active unit's own real foot position (anchor + footY, the exact same point
  // its real shadow-caster box uses — NOT the tile's plain grid-cell center, which is offset from
  // where a standing unit's feet actually are; see syncOverlay's own comment). Drawn at a higher z
  // than both the flat hex (0.5) and the glow sprite (0.45) so it always shows on top — the hex's
  // own color/size/opacity/pulse timing are never read or written here.
  private activeTurnShadowCatcherTexture: THREE.CanvasTexture;
  private activeTurnShadowCatcherMaterial: THREE.SpriteMaterial;
  private activeTurnShadowCatcher: THREE.Sprite;

  // Animated units (see THREEJS_MILESTONE1_HANDOFF.md) — one persistent mesh per live unit id,
  // repositioned/retextured/rescaled every frame in syncUnits rather than rebuilt, since units
  // (unlike terrain/decor) change position, pose and art every frame. HP bars, hover/selection
  // highlight, and portal FX stay on the old Canvas2D-shim units canvas on purpose (see
  // BattleEngine.renderUnitsAndOverlays' skipUnitSprites param) — only the character sprite art
  // itself moves here.
  private unitGroup = new THREE.Group();
  /** Contact-shadow footprints (z=0.51 — above tiles/overlay, below decorations and units).
   * Deliberately NOT tied to unitGroup's visibility: BattleCanvas hides the Three unit sprites
   * (units draw on the Canvas2D top layer), but these are ground marks, so they stay here. */
  private contactShadowGroup = new THREE.Group();
  private contactShadowTexture = makeContactShadowTexture();
  // Textures are shared by image (same pattern as tiles/decor — cheap, no per-unit GPU upload),
  // but each unit gets its OWN material (see UnitMeshEntry) so u.fade can drive real per-unit
  // opacity: a shared material (the tile/decor pattern) would make every unit sharing one sprite
  // frame fade in/out together, which is wrong the instant two of them are mid-death at once.
  private unitTexCache = new Map<HTMLImageElement, THREE.Texture>();
  private unitEntries = new Map<string, UnitMeshEntry>();

  /** The elemental-FX canvas is intentionally between the ground renderer and the visual
   * actors/props canvas. Keep Three's copies of sprites and decorations off the ground canvas
   * whenever that compositing path is active, otherwise an authored effect can cover them. */
  setSpritesAndDecorationsVisible(unitsVisible: boolean, decorationsVisible = unitsVisible): void {
    this.unitGroup.visible = unitsVisible;
    this.decorGroup.visible = decorationsVisible;
  }

  // MILESTONE 3 — real world-space ground mist + drift particles, owned end-to-end by
  // ThreeAtmosphere (see that file's header comment for why scene.fog isn't used and why this
  // sits at Z > 3, strictly above every mesh above). lastFrameTime is only for this: nothing
  // else in the file needs a real dt (render() takes cssW/cssH only, see its own comment).
  private atmosphere = new ThreeAtmosphere();
  private lastFrameTime = performance.now();

  // MILESTONE 4 — bloom applies to the whole scene, per direct instruction (previously
  // selective, wisps-only — see git history if that's ever wanted back). bloomComposer renders
  // the real scene through UnrealBloomPass (which extracts/blurs whatever clears
  // BLOOM_THRESHOLD on its own), finalComposer renders it again normally and additively mixes
  // that bloom texture back in via mixPass.
  private bloomComposer: EffectComposer;
  private finalComposer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  // Embers still mark themselves onto this layer (see ThreeAtmosphere.markBloomLayer) from
  // when bloom was selective — harmless now that bloom applies to everything regardless of
  // layer, kept only so that call site doesn't need its own removal too.
  private readonly bloomLayerIndex = 1;

  constructor(
    canvas: HTMLCanvasElement,
    private engine: BattleEngine,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap was removed from this Three.js version (falls back to PCFShadowMap with a
    // console warning) — request PCFShadowMap directly instead.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.OrthographicCamera(0, 1, 0, 1, 0.1, 2000);
    this.camera.position.z = 100;
    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = glowCanvas.height = 128;
    const glowCtx = glowCanvas.getContext("2d")!;
    const gradient = glowCtx.createRadialGradient(64, 64, 6, 64, 64, 64);
    gradient.addColorStop(0, "rgba(255,255,255,0.92)");
    gradient.addColorStop(0.32, "rgba(255,255,255,0.45)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    glowCtx.fillStyle = gradient;
    glowCtx.fillRect(0, 0, 128, 128);
    this.activeTurnGlowTexture = new THREE.CanvasTexture(glowCanvas);
    this.activeTurnGlowMaterial = new THREE.SpriteMaterial({ map: this.activeTurnGlowTexture, transparent: true, depthWrite: false, opacity: 0 });
    this.activeTurnGlow = new THREE.Sprite(this.activeTurnGlowMaterial);
    this.activeTurnGlow.position.z = 0.45;
    this.activeTurnGlow.visible = false;
    // ADDITIVE ONLY — see the field's own comment. THREE.ShadowMaterial (reveal-the-real-shadow)
    // was tried first but the real WebGL shadow simply doesn't reach close enough to a unit's own
    // anchor point to ever read as "touching their feet" — confirmed empirically, not assumed; see
    // git history for that attempt. This is a direct dark radial-gradient sprite instead (same
    // CanvasTexture technique as activeTurnGlowTexture just above, inverted to dark-center/
    // transparent-edge), anchored at the same world position the unit's own real shadow-caster box
    // uses — independent of the real shadow computation's reach, so it reliably darkens right at
    // the feet regardless.
    const feetCanvas = document.createElement("canvas");
    feetCanvas.width = feetCanvas.height = 128;
    const feetCtx = feetCanvas.getContext("2d")!;
    const feetGradient = feetCtx.createRadialGradient(64, 64, 4, 64, 64, 64);
    feetGradient.addColorStop(0, "rgba(20,16,12,0.6)");
    feetGradient.addColorStop(0.55, "rgba(20,16,12,0.32)");
    feetGradient.addColorStop(1, "rgba(20,16,12,0)");
    feetCtx.fillStyle = feetGradient;
    feetCtx.fillRect(0, 0, 128, 128);
    this.activeTurnShadowCatcherTexture = new THREE.CanvasTexture(feetCanvas);
    this.activeTurnShadowCatcherMaterial = new THREE.SpriteMaterial({
      map: this.activeTurnShadowCatcherTexture,
      transparent: true,
      depthWrite: false,
      opacity: 0,
    });
    this.activeTurnShadowCatcher = new THREE.Sprite(this.activeTurnShadowCatcherMaterial);
    this.activeTurnShadowCatcher.position.z = 0.51;
    this.activeTurnShadowCatcher.visible = false;
    // Author-controlled lighting (Mission.environment/sunIntensity/ambientIntensity, editable in
    // the Map Editor's "Iluminação" section — see GameApp.tsx) — an explicit sunIntensity/
    // ambientIntensity always wins; otherwise "indoor" gets its own flatter preset, and anything
    // else (including missing/"outdoor") gets the renderer's own default.
    const indoor = engine.mission.environment === "indoor";
    this.sunLight.intensity = engine.mission.sunIntensity ?? (indoor ? INDOOR_SUN_INTENSITY : DEFAULT_SUN_INTENSITY);
    this.hemiLight.intensity = engine.mission.ambientIntensity ?? (indoor ? INDOOR_AMBIENT_INTENSITY : DEFAULT_AMBIENT_INTENSITY);
    this.sunLight.castShadow = true;
    // 2048, not 1024 — casters are small boxes (a fraction of a unit's own width), so a coarser
    // map under-resolves them into faint/noisy blobs even at full light intensity.
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.bias = -0.0015;
    this.scene.add(this.hemiLight);
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
    this.scene.add(this.shadowCasterGroup);
    this.scene.add(this.backdropMesh);
    this.scene.add(this.tileGroup);
    this.scene.add(this.overlayGlowGroup);
    this.scene.add(this.overlayGroup);
    this.scene.add(this.activeTurnGlow);
    this.scene.add(this.activeTurnShadowCatcher);
    this.scene.add(this.contactShadowGroup);
    this.scene.add(this.decorGroup);
    this.scene.add(this.unitGroup);
    this.scene.add(this.atmosphere.group);

    // Only the wisp embers ever render into the bloom-only pass (everything else gets forced to
    // black during it, see render()) — a low fixed threshold is correct now, since there's
    // nothing else present that could wrongly cross it regardless of setting; the intensity
    // slider maps directly to strength, which alone gets dramatic at high values against a
    // black backdrop.
    this.atmosphere.markBloomLayer(this.bloomLayerIndex);

    // Built at (1,1) here; setSize() (always called at least once before the first real render,
    // same as the camera/renderer above) gives both composers real dimensions.
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), engine.mission.bloomIntensity ?? DEFAULT_BLOOM_INTENSITY, BLOOM_RADIUS, BLOOM_THRESHOLD);
    this.bloomComposer = new EffectComposer(this.renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomComposer.addPass(this.bloomPass);

    const mixPass = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          baseTexture: { value: null },
          bloomTexture: { value: this.bloomComposer.renderTarget2.texture },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D baseTexture;
          uniform sampler2D bloomTexture;
          varying vec2 vUv;
          void main() {
            gl_FragColor = texture2D(baseTexture, vUv) + vec4(1.0) * texture2D(bloomTexture, vUv);
          }
        `,
        defines: {},
      }),
      "baseTexture",
    );
    mixPass.needsSwap = true;

    this.finalComposer = new EffectComposer(this.renderer);
    this.finalComposer.addPass(new RenderPass(this.scene, this.camera));
    this.finalComposer.addPass(mixPass);
    // Combining two textures with raw shader math (above) bypasses the renderer's own automatic
    // output color-space encoding that a composer's LAST pass would normally apply when it
    // renders straight to the canvas — this pass restores it, matching the official Three.js
    // selective-bloom example's own pipeline exactly.
    this.finalComposer.addPass(new OutputPass());
  }

  /** Aims the sun so its fixed-direction shadow follows whatever's actually on screen (camera
   * pans; the shadow-caster geometry doesn't move relative to the world, so the light has to
   * instead) — same reasoning as why tiles are built once and only the camera moves (see module
   * comment). The shadow camera's frustum SIZE only depends on viewport size, so that part is
   * cached and skipped most frames; target/position are cheap vector math, recomputed every
   * frame unconditionally. */
  private updateSun(cssW: number, cssH: number, camX: number, camY: number): void {
    const centerX = camX + cssW / 2;
    const centerY = -camY - cssH / 2;
    this.sunLight.target.position.set(centerX, centerY, 0);
    this.sunLight.position.set(centerX, centerY, 0).addScaledVector(SUN_DIRECTION, -SUN_DISTANCE);
    if (cssW === this.lastShadowFrustumW && cssH === this.lastShadowFrustumH) return;
    this.lastShadowFrustumW = cssW;
    this.lastShadowFrustumH = cssH;
    // Half-diagonal (plus margin for shadow-caster elevation reach) rather than half-width/
    // height: the shadow camera looks along SUN_DIRECTION, not straight down -Z like the main
    // camera, so it needs to cover the visible box from an angle, not just match its footprint.
    const half = Math.hypot(cssW, cssH) * 0.65 + 250;
    const shadowCam = this.sunLight.shadow.camera as THREE.OrthographicCamera;
    shadowCam.left = -half;
    shadowCam.right = half;
    shadowCam.top = half;
    shadowCam.bottom = -half;
    shadowCam.near = 10;
    shadowCam.far = SUN_DISTANCE * 2.2;
    shadowCam.updateProjectionMatrix();
  }

  setSize(cssW: number, cssH: number, dpr: number): void {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(Math.max(1, cssW), Math.max(1, cssH), false);
    this.camera.left = 0;
    this.camera.right = Math.max(1, cssW);
    this.camera.top = Math.max(1, cssH);
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
    // MILESTONE 4 — EffectComposer captures the renderer's pixel ratio ONCE at construction
    // time and never re-reads it; without this explicit setPixelRatio() call, bloom would stay
    // locked to whatever dpr was active when the composer was built (effectively 1, since this
    // constructor runs before the first real setSize()), rendering at the wrong resolution on
    // any HiDPI display. setPixelRatio() also calls setSize() internally (with the CURRENT
    // this._width/_height, still 1x1 the very first time — composer.setSize() right after this
    // is what gives it real dimensions), which is why both calls are needed here, in this order,
    // on BOTH composers now (selective bloom uses two).
    this.bloomComposer.setPixelRatio(dpr);
    this.bloomComposer.setSize(Math.max(1, cssW), Math.max(1, cssH));
    this.finalComposer.setPixelRatio(dpr);
    this.finalComposer.setSize(Math.max(1, cssW), Math.max(1, cssH));
  }

  private materialFor(id: TerrainId, variant: number): THREE.MeshLambertMaterial {
    const key = `${id}:${variant}`;
    const hit = this.materialCache.get(key);
    if (hit) return hit;
    const variants = this.engine.art.tiles[id];
    const img = variants?.[variant] ?? variants?.[0];
    if (!img) return this.fallbackMaterial;
    const tex = new THREE.Texture(img);
    // Three's default flipY=true is what this needs: with the Y-negation in hexWorld/
    // render() (see module comment), a plane's local Y=-0.5 edge ends up at the screen
    // BOTTOM, and flipY=true samples the image's bottom row there — matching Canvas2D's
    // drawImage orientation. (Verified numerically, not just by eye — see module comment.)
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    this.materialCache.set(key, mat);
    return mat;
  }

  /** (Re)builds every tile mesh at its fixed world position. Called once per map and again
   * whenever board dimensions or the mission itself changes — never on an ordinary camera
   * pan/zoom, which only ever moves the camera (see render()). */
  private ensureBuilt(tile: number): void {
    const engine = this.engine;
    // tile is part of the identity check (not just cols/rows/missionId) — every mesh's world
    // position and scale is baked in at build time from hexWorld(..., tile), so a zoom change
    // (which changes `tile` without touching cols/rows/missionId) has to trigger a full rebuild
    // too. Decorations already keyed on tile (see ensureDecorBuilt's builtDecorKey); terrain
    // didn't, so zooming left the ground grid frozen at its old scale/position while the camera,
    // decorations and units all repositioned themselves for the new tile size every frame —
    // reads as tiles vanishing/sliding out from under everything else on zoom.
    if (this.builtCols === engine.cols && this.builtRows === engine.rows && this.builtMissionId === engine.mission.id && this.builtTile === tile)
      return;
    for (const entry of this.tileMeshes.values()) this.tileGroup.remove(entry.mesh);
    this.tileMeshes.clear();
    this.builtCols = engine.cols;
    this.builtRows = engine.rows;
    this.builtMissionId = engine.mission.id;
    this.builtTile = tile;

    for (let row = 0; row < engine.rows; row++) {
      for (let col = 0; col < engine.cols; col++) {
        const key = row * engine.cols + col;
        const id = tileAt(engine.tiles, engine.cols, col, row);
        const variant = engine.tileVariants[key] ?? 0;
        const rot = engine.tileRots[key] ?? 0;
        const mat = this.materialFor(id, variant);
        const mesh = new THREE.Mesh(this.hexGeo, mat);
        const { wx, wy } = hexWorld(col, row, tile);
        mesh.scale.set(tile * 2, tile * 2, 1);
        // Y negated — see module comment on the frustum/Y-flip.
        mesh.position.set(wx, -wy, 0);
        // A turned hex spins about its own center — see Canvas2D renderGround's identical
        // rot*PI/3 comment. Negated: a mesh's own local rotation isn't touched by the
        // position negation above, so Three's standard (non-inverted-frustum) CCW-positive
        // Z-rotation would appear CCW on screen — the opposite of ctx.rotate()'s CW-positive
        // screen convention — unless flipped here.
        if (rot) mesh.rotation.z = (-rot * Math.PI) / 3;
        // MILESTONE 2 — the ground is the one surface real shadows land on (see handoff doc);
        // it never casts (stays flat, castShadow defaults to false).
        mesh.receiveShadow = true;
        this.tileGroup.add(mesh);
        this.tileMeshes.set(key, { mesh, id, variant, rot });
      }
    }
  }

  /** Repositions/retextures only the tiles that actually changed since the last build (a chest
   * opened, a terrain-changing effect fired, ...) — cheap, since most frames change nothing. */
  private syncDirtyTiles(): void {
    const engine = this.engine;
    for (const [key, entry] of this.tileMeshes) {
      const row = Math.floor(key / engine.cols);
      const col = key % engine.cols;
      const id = tileAt(engine.tiles, engine.cols, col, row);
      const variant = engine.tileVariants[key] ?? 0;
      const rot = engine.tileRots[key] ?? 0;
      if (id !== entry.id || variant !== entry.variant) {
        entry.mesh.material = this.materialFor(id, variant);
        entry.id = id;
        entry.variant = variant;
      }
      if (rot !== entry.rot) {
        entry.mesh.rotation.z = (-rot * Math.PI) / 3;
        entry.rot = rot;
      }
    }
  }

  /** Lazily loads a decoration's art file the same way BattleEngine.decorArtReady does — a prop
   * whose art hasn't finished loading yet just doesn't get a mesh (see ensureDecorBuilt) rather
   * than falling back to a placeholder, since ensureDecorBuilt reruns on the next dirty check
   * and a loading placeholder box would be more visually wrong than a prop appearing a frame
   * late. Shares `engine.art.decorations` with the existing Canvas2D renderer's own cache —
   * one image, loaded once, however many renderers end up reading it this milestone. */
  private decorImageReady(fileId: string): HTMLImageElement | null {
    let img = this.engine.art.decorations[fileId];
    if (!img) {
      img = new Image();
      img.src = decorationImage(fileId);
      this.engine.art.decorations[fileId] = img;
    }
    return img.naturalWidth > 0 ? img : null;
  }

  private decorMaterialFor(fileId: string, img: HTMLImageElement): THREE.MeshBasicMaterial {
    const hit = this.decorMatCache.get(fileId);
    if (hit) return hit;
    const tex = new THREE.Texture(img);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    // Decoration art is cut-out PNGs (alpha, not opaque like terrain tiles) — transparent:true
    // is required or the alpha channel is ignored and every prop draws as an opaque rectangle.
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    this.decorMatCache.set(fileId, mat);
    return mat;
  }

  /** Shadow-only twin of decorMaterialFor, for true-silhouette shadow casting instead of the old
   * invisible-box caster: same cached texture (never re-decoded), but alphaTest instead of alpha
   * blending — Three's shadow depth pass respects alphaTest (hard cutout at that texture-alpha
   * threshold), giving a shadow shaped like the prop's actual cutout art, not a box. colorWrite
   * false keeps it invisible in the normal color pass (same trick the old box caster used) since
   * this mesh exists purely to cast into the shadow map. */
  private decorShadowMaterialFor(fileId: string, colorMat: THREE.MeshBasicMaterial): THREE.MeshBasicMaterial {
    const hit = this.decorShadowMatCache.get(fileId);
    if (hit) return hit;
    // side: DoubleSide is required for a flat plane to cast any shadow at all — Three's shadow
    // pass renders back-faces by default (to reduce self-shadow acne on closed volumes), and a
    // single flat PlaneGeometry has no back face for that pass to find, so without this the whole
    // caster silently draws nothing into the shadow map.
    const mat = new THREE.MeshBasicMaterial({ map: colorMat.map, alphaTest: 0.5, colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
    this.decorShadowMatCache.set(fileId, mat);
    return mat;
  }

  /** (Re)builds every ground/behind-layer decoration mesh at its fixed world position — same
   * "built once, camera moves instead" philosophy as tiles (see ensureBuilt). Skips "front"-
   * layer and foreground=true props on purpose: those are meant to occlude character sprites,
   * which still live on the separate units canvas STACKED ABOVE this one — moving them here
   * would put them permanently behind every unit instead. They keep rendering through
   * BattleEngine.renderUnitsAndOverlays exactly as before, unchanged, until units themselves
   * move onto this renderer and a real depth order between the two exists. */
  private ensureDecorBuilt(tile: number): void {
    const engine = this.engine;
    const key = `${engine.mission.id}:${engine.decorations.length}:${tile}`;
    if (key === this.builtDecorKey) return;
    for (const entry of this.decorEntries) {
      this.decorGroup.remove(entry.mesh);
      this.shadowCasterGroup.remove(entry.shadowMesh);
    }
    this.decorEntries = [];
    this.builtDecorKey = key;

    for (const p of engine.decorations) {
      const def = DECORATIONS[p.id];
      if (!def) continue;
      const decorLayer = def.unitLayer ?? (def.foreground ? "front" : "ground");
      // Fog 2 deliberately sits above every decoration but below units. Front props therefore
      // belong in this same Three layer too; keeping them on the top 2D unit canvas would make
      // them unavoidably render over the fog regardless of their world Z.

      const facing = decorationFacing(p.id, p.rot ?? 0, (file) => this.decorImageReady(file) !== null);
      const fileId = facing.own ? facing.file : p.id;
      const img = this.decorImageReady(fileId);
      if (!img) continue; // art still loading — picked up on the next ensureDecorBuilt (see decorImageReady)

      let sumWx = 0;
      let sumWy = 0;
      for (const { dx, dy } of placedFootprint(p)) {
        const { wx, wy } = hexWorld(p.x + dx, p.y + dy, tile);
        sumWx += wx;
        sumWy += wy;
      }
      const n = def.footprint.length;
      const { w, h, dy: liftY } = decorSize(p.id, def, tile);
      const wx = sumWx / n;
      const groundWy = sumWy / n; // ground contact, before decorSize's liftY visual offset
      const wy = groundWy + liftY;

      const mat = this.decorMaterialFor(fileId, img);
      const mesh = new THREE.Mesh(this.quadGeo, mat);
      // Y negated to match the tile/camera convention (see module comment); z=1 keeps decor
      // reliably in front of the flat ground plane at z=0 for any depth-sorting Three does
      // between transparent objects.
      mesh.position.set(wx, -wy, 1);
      if (facing.step === 0) {
        mesh.scale.set(w, h, 1);
      } else if (facing.own) {
        // A prop with its own per-side art mirrors instead of rotating — see
        // decorationFacing's own comment for why (a mirrored drawing still faces outward
        // correctly; a rotated one would tilt the art instead of turning which side faces
        // the viewer).
        mesh.scale.set(facing.mirror ? -w : w, h, 1);
      } else {
        // No dedicated side art: fall back to spinning the bitmap (a placeholder, same as
        // Canvas2D's own fallback) — negated for the same reason tile rotation is (see
        // ensureBuilt's comment).
        mesh.scale.set(w, h, 1);
        mesh.rotation.z = (-facing.step * Math.PI) / 3;
      }
      this.decorGroup.add(mesh);

      // True-silhouette shadow caster (see decorShadowMaterialFor's own comment): the prop's own
      // cutout art, positioned at ground contact (not wy, which already includes decorSize's
      // liftY visual nudge) so the shadow lands where the prop actually stands. Same width/mirror/
      // facing-spin branches as the visible mesh above so the cast silhouette matches what's on
      // screen — but standing vertically (rotation.x), NOT flat like the visible mesh: a flat
      // plane has no depth, so it sits entirely at one fixed height with nothing touching the
      // ground, making its whole shadow float free of the prop (confirmed empirically — "mega
      // Peter Pan" on the equivalent unit version of this bug). Rotating it up turns local Y
      // (image-space up/down) into world Z, so scale.y=elevation + position.z=elevation/2 puts its
      // BASE exactly at the ground (z=0) at the prop's contact point and its top at `elevation`,
      // same span the old box caster used.
      const elevation = Math.max(1, h * DECOR_SHADOW_HEIGHT_SCALE);
      const shadowMat = this.decorShadowMaterialFor(fileId, mat);
      const shadowMesh = new THREE.Mesh(this.quadGeo, shadowMat);
      shadowMesh.castShadow = true;
      shadowMesh.position.set(wx, -groundWy, elevation / 2 - DECOR_SHADOW_GROUND_INSET / 2);
      if (facing.step === 0) {
        shadowMesh.rotation.x = Math.PI / 2;
        shadowMesh.scale.set(w, elevation + DECOR_SHADOW_GROUND_INSET, 1);
      } else if (facing.own) {
        shadowMesh.rotation.x = Math.PI / 2;
        shadowMesh.scale.set(facing.mirror ? -w : w, elevation + DECOR_SHADOW_GROUND_INSET, 1);
      } else {
        shadowMesh.rotation.set(Math.PI / 2, 0, (-facing.step * Math.PI) / 3);
        shadowMesh.scale.set(w, elevation + DECOR_SHADOW_GROUND_INSET, 1);
      }
      this.shadowCasterGroup.add(shadowMesh);

      this.decorEntries.push({ mesh, placement: p, shadowMesh });
    }
  }

  private unitTextureFor(img: HTMLImageElement): THREE.Texture {
    const hit = this.unitTexCache.get(img);
    if (hit) return hit;
    const tex = new THREE.Texture(img);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    this.unitTexCache.set(img, tex);
    return tex;
  }

  /** Full pose/animation parity with BattleEngine's own Canvas2D draw loop — walk/attack/cast/
   * counter poses, every pose-specific size correction, live idle motion (bob/sway/breath) and
   * high-ground lift, all computed once by BattleEngine.unitVisual (see that method's own
   * comment) so this renderer can never drift out of sync with the Canvas2D-shim path it
   * replaces. Position comes from unitAnchor, the public world-space twin of the private
   * unitPixel/footprintCentroid the Canvas2D path actually draws with — including their
   * front-row-footprint averaging for boss/multi-hex units and their mid-move easing, so this
   * renderer's units track the exact same position the hit boxes and combat math use, not an
   * approximation. */
  private syncUnits(tile: number): void {
    const engine = this.engine;
    const seen = new Set<string>();

    for (const u of engine.units) {
      if (u.fade <= 0 || engine.unitHidden(u)) continue;
      const v = engine.unitVisual(u, tile);
      const img = v.img;
      if (!img || img.naturalWidth === 0) continue; // art still loading — picked up next frame

      seen.add(u.id);
      let entry = this.unitEntries.get(u.id);
      if (!entry) {
        const material = new THREE.MeshBasicMaterial({ map: this.unitTextureFor(img), transparent: true, depthWrite: false });
        const mesh = new THREE.Mesh(this.quadGeo, material);
        // Atmosphere's Fog 2 sheets use renderOrder 1: units must remain the final visible
        // sprite layer (2), while decorations remain the base layer (0).
        mesh.renderOrder = 2;
        this.unitGroup.add(mesh);
        // True-silhouette shadow caster: the unit's own sprite art, alpha-tested instead of
        // alpha-blended (colorWrite off — invisible in the normal color pass, same trick the old
        // box caster used) so the shadow map sees this unit's real cutout shape, not a box.
        // Real elevation (see UNIT_SHADOW_HEIGHT_SCALE's comment), repositioned every frame below
        // alongside the visible sprite, same scale as it so the cast silhouette actually matches.
        // side: DoubleSide — see decorShadowMaterialFor's identical comment: a flat plane needs
        // this to cast any shadow at all, since Three's shadow pass renders back-faces by default.
        const shadowMaterial = new THREE.MeshBasicMaterial({ map: this.unitTextureFor(img), alphaTest: 0.5, colorWrite: false, depthWrite: false, side: THREE.DoubleSide });
        const shadowMesh = new THREE.Mesh(this.quadGeo, shadowMaterial);
        shadowMesh.castShadow = true;
        this.shadowCasterGroup.add(shadowMesh);
        const contactMaterial = new THREE.MeshBasicMaterial({ map: this.contactShadowTexture, transparent: true, depthWrite: false });
        const contactMesh = new THREE.Mesh(this.quadGeo, contactMaterial);
        this.contactShadowGroup.add(contactMesh);
        entry = { mesh, material, img: null, shadowMesh, shadowMaterial, contactMesh, contactMaterial };
        this.unitEntries.set(u.id, entry);
      }
      entry.mesh.visible = true;
      if (entry.img !== img) {
        entry.material.map = this.unitTextureFor(img);
        entry.material.needsUpdate = true;
        entry.shadowMaterial.map = this.unitTextureFor(img);
        entry.shadowMaterial.needsUpdate = true;
        entry.img = img;
      }
      // Same fade-in/out and "already acted this player unit" dimming as
      // renderUnitsAndOverlays' ctx.globalAlpha — real per-unit opacity, not shared, since
      // entry.material is this unit's own instance (see unitTexCache's comment).
      entry.material.opacity = u.fade * (u.moved && u.side === "player" && engine.phase === "player" ? 0.8 : 1);

      const anchor = engine.unitAnchor(u);
      // Canvas2D draws the image at local Y in [-h+footOffset, footOffset] (Y-down, relative
      // to the translated anchor+sway/footY/bob/lift origin), then ctx.scale(scaleX, scaleY)
      // stretches that box AWAY FROM the origin (y=0), not around its own center — so the
      // quad's center has to be repositioned by the same scale, not just resized, to land in
      // the same place a plain "scale the mesh in place" would miss. Horizontal is symmetric
      // (image spans -w/2..w/2) so scaleX only ever needs to flip its sign for mirroring, same
      // pattern ensureDecorBuilt already uses for a decoration's own-art facing.
      const centerYLocal = (v.footOffset - v.h / 2) * v.scaleY;
      const wx = anchor.worldX + v.sway;
      const wy = anchor.worldY + v.footY + v.bob - v.lift + centerYLocal;
      // Y negated and Z derived from row — see module comment on the Y-flip and
      // ensureDecorBuilt's own comment on z ordering vs decorations (z=1) and tiles (z=0).
      entry.mesh.position.set(wx, -wy, 2 + u.drawY * 0.001);
      entry.mesh.scale.set(v.scaleX * v.w, v.scaleY * v.h, 1);

      // Shadow caster tracks the sprite's ground-contact point (anchor + footY, ignoring bob/lift
      // so a mid-step/high-ground unit's shadow stays anchored to the real ground instead of
      // floating with the visual lift trick — see decorSize's groundWy for the same idea applied
      // to props). Elevation grows a little with lift, echoing the fake shadow's own "raised =
      // slightly longer shadow" stretch (see engine.ts's shadowDirX/Y block) without trying to
      // match it exactly.
      // Standing vertically (rotation.x), NOT flat like the visible mesh — a flat plane has no
      // depth, so it would sit entirely at one fixed height with nothing touching the ground,
      // making its whole shadow float free of the character (confirmed: this was tried first and
      // looked badly detached, "mega Peter Pan"). Rotating it up turns local Y (image-space
      // up/down) into world Z, so scale.y=elevation + position.z=elevation/2 puts its BASE
      // exactly at the ground (z=0) at the foot anchor and its top at `elevation`, same span the
      // old box caster used — except the caster is now the real silhouette, not a box.
      const elevation = Math.max(1, v.h * UNIT_SHADOW_HEIGHT_SCALE + v.lift * 0.6);
      entry.shadowMesh.rotation.x = Math.PI / 2;
      entry.shadowMesh.scale.set(v.scaleX * v.w, elevation + UNIT_SHADOW_GROUND_INSET, 1);
      entry.shadowMesh.position.set(anchor.worldX + v.sway, -(anchor.worldY + v.footY), elevation / 2 - UNIT_SHADOW_GROUND_INSET / 2);
      entry.shadowMesh.visible = true;

      // Contact shadow: same ground-contact point as the caster above (ignores bob/lift so it
      // stays on the ground), fading and shrinking as the unit lifts off it.
      const liftFade = Math.max(0, 1 - v.lift / Math.max(1, tile * 0.6));
      const footW = Math.abs(v.scaleX) * v.w;
      entry.contactMesh.position.set(anchor.worldX + v.sway, -(anchor.worldY + v.footY), 0.51);
      entry.contactMesh.scale.set(footW * CONTACT_SHADOW_W * (0.7 + 0.3 * liftFade), footW * CONTACT_SHADOW_H * (0.7 + 0.3 * liftFade), 1);
      entry.contactMaterial.opacity = CONTACT_SHADOW_OPACITY * u.fade * liftFade;
      entry.contactMesh.visible = liftFade > 0;
    }

    for (const [id, entry] of this.unitEntries) {
      if (seen.has(id)) continue;
      if (engine.units.some((u) => u.id === id)) {
        // Still exists (just off-screen/out of sight/faded this frame) — hide, don't discard,
        // so it doesn't need rebuilding the instant it's visible again.
        entry.mesh.visible = false;
        entry.shadowMesh.visible = false;
        entry.contactMesh.visible = false;
      } else {
        this.unitGroup.remove(entry.mesh);
        this.shadowCasterGroup.remove(entry.shadowMesh);
        this.contactShadowGroup.remove(entry.contactMesh);
        entry.material.dispose(); // owned per-unit — see unitTexCache's comment; the texture itself is shared, kept
        entry.shadowMaterial.dispose(); // same reasoning, shadowMaterial is this unit's own instance too
        entry.contactMaterial.dispose();
        this.unitEntries.delete(id);
      }
    }
  }

  /** Fog-of-war visibility, rechecked every frame without touching geometry — cheap, and most
   * missions have `fog` off entirely (see Mission.fog), in which case this is a no-op loop that
   * only ever sets `visible = true`. */
  private syncDecorVisibility(): void {
    const engine = this.engine;
    if (!engine.fogged) {
      for (const entry of this.decorEntries) entry.mesh.visible = entry.shadowMesh.visible = true;
      return;
    }
    for (const entry of this.decorEntries) {
      const p = entry.placement;
      const visible = placedFootprint(p).some((f) => engine.explored(p.x + f.dx, p.y + f.dy));
      entry.mesh.visible = entry.shadowMesh.visible = visible;
    }
  }

  /** rgba(r,g,b[,a]) -> a cached, unlit, transparent material — one per exact fill string
   * (color AND alpha both baked into the cache key, since neither animates once resolved: see
   * overlayGroup's own comment on why the canvas-only glow pulse is skipped here). */
  private overlayMaterialFor(fill: string): THREE.MeshBasicMaterial {
    const hit = this.overlayMatCache.get(fill);
    if (hit) return hit;
    const m = /rgba?\(([^,]+),([^,]+),([^,]+)(?:,([^)]+))?\)/.exec(fill);
    const r = m ? Number(m[1]) / 255 : 1;
    const g = m ? Number(m[2]) / 255 : 1;
    const b = m ? Number(m[3]) / 255 : 1;
    const a = m && m[4] !== undefined ? Number(m[4]) : 1;
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b), transparent: true, opacity: a, depthWrite: false });
    this.overlayMatCache.set(fill, mat);
    return mat;
  }

  /** Mirrors the 2D renderer's `drawImage(..., cover)` plus its 42% black wash. Most scenes
   * remain camera-backed, while O Vau's artwork is pinned to its terrain so the painted river
   * continues the river made from map hexes as the camera pans. */
  private syncBackdrop(cssW: number, cssH: number, tile: number): void {
    const image = this.engine.art.backdrops[this.engine.mission.id] ?? null;
    if (image !== this.backdropImage) {
      this.backdropTexture?.dispose();
      this.backdropImage = image;
      this.backdropTexture = image ? new THREE.Texture(image) : null;
      if (this.backdropTexture) {
        this.backdropTexture.needsUpdate = true;
        this.backdropTexture.colorSpace = THREE.SRGBColorSpace;
      }
      this.backdropMaterial.map = this.backdropTexture;
      this.backdropMaterial.needsUpdate = true;
    }
    this.backdropMesh.visible = !!image;
    if (!image) return;
    const imageRatio = image.width / Math.max(1, image.height);
    if (this.engine.mission.id === "vau") {
      // O Vau's river occupies rows 5–6 (with shore rows 4 and 7). The supplied panorama's
      // water band sits at ~56% down the frame. Anchor those two centers together in world
      // space; unlike a decorative screen background, it now moves exactly with the map.
      const boardWidth = tile * SQRT3 * this.engine.cols;
      const width = Math.max(boardWidth * 1.35, cssW, cssH * imageRatio);
      const height = width / imageRatio;
      const mapRiverY = tile * (2.4 + 1.5 * 5.5 + 1);
      const panoramaRiverY = 0.56;
      const centerY = mapRiverY - (panoramaRiverY - 0.5) * height;
      this.backdropMesh.position.set(boardWidth / 2, -centerY, -2);
      this.backdropMesh.scale.set(width, height, 1);
      return;
    }
    const viewRatio = cssW / Math.max(1, cssH);
    const width = imageRatio > viewRatio ? cssH * imageRatio : cssW;
    const height = imageRatio > viewRatio ? cssH : cssW / imageRatio;
    this.backdropMesh.position.set(this.engine.camX + cssW / 2, -this.engine.camY - cssH / 2, -2);
    this.backdropMesh.scale.set(width, height, 1);
  }

  /** A faint, pooled halo restores the depth that the 2D renderer's shadowBlur gave blue
   * movement/range cells. Only blue tactical overlays receive it; spell and danger colors stay
   * deliberately flat so the board remains calm and readable. */
  private placeBlueOverlayGlow(x: number, y: number, tile: number, index: number): void {
    let glow = this.overlayGlowPool[index];
    if (!glow) {
      glow = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: this.activeTurnGlowTexture, color: 0x8cc8f5, transparent: true, depthWrite: false, opacity: 0.15 }),
      );
      this.overlayGlowGroup.add(glow);
      this.overlayGlowPool.push(glow);
    }
    const { wx, wy } = hexWorld(x, y, tile);
    const pulse = 0.5 + 0.5 * Math.sin(this.engine.time * 3.8);
    glow.position.set(wx, -wy, 0.42);
    glow.scale.setScalar(tile * (2.08 + pulse * 0.24));
    (glow.material as THREE.SpriteMaterial).opacity = 0.1 + pulse * 0.1;
    glow.visible = true;
  }

  /** Movement/attack/spell-range highlight + the active-turn ring, from the same cell/color
   * data renderBoardOverlays (Canvas2D path) draws from — see overlayGroup's own comment for
   * why this renders as real geometry instead of a 2D fill. Pool index reused across frames
   * (see overlayMeshPool): cheaper than tearing down and rebuilding a THREE.Mesh per cell every
   * single frame for what is usually the same handful of cells frame to frame. */
  private syncOverlay(tile: number): void {
    const engine = this.engine;
    let idx = 0;
    let glowIdx = 0;
    const place = (x: number, y: number, fill: string) => {
      let mesh = this.overlayMeshPool[idx];
      if (!mesh) {
        mesh = new THREE.Mesh(this.hexGeo, this.overlayMaterialFor(fill));
        this.overlayGroup.add(mesh);
        this.overlayMeshPool.push(mesh);
      } else {
        mesh.material = this.overlayMaterialFor(fill);
        mesh.visible = true;
      }
      const { wx, wy } = hexWorld(x, y, tile);
      // 1.84 = 2 * 0.92, matching the Canvas2D path's hexPath(ctx, cx, cy, tile * 0.92) radius
      // (see buildHexGeometry's comment on why *2 turns this geometry's own radius-0.5 shape
      // into a `tile`-radius hex).
      mesh.scale.set(tile * 1.84, tile * 1.84, 1);
      // Y negated, z=0.5 — see module comment on the Y-flip and overlayGroup's own comment on
      // why this sits between tiles (z=0) and decorations (z=1).
      mesh.position.set(wx, -wy, 0.5);
      idx++;
    };
    for (const layer of engine.boardOverlayLayers()) {
      const rgb = /rgba?\(([^,]+),([^,]+),([^,]+)/.exec(layer.fill);
      const isBlue = !!rgb && Number(rgb[3]) > Number(rgb[1]) && Number(rgb[3]) > Number(rgb[2]);
      for (const c of layer.cells) {
        place(c.x, c.y, layer.fill);
        if (isBlue) this.placeBlueOverlayGlow(c.x, c.y, tile, glowIdx++);
      }
    }
    const active = engine.activeTurnHighlight();
    if (active) {
      place(active.x, active.y, active.fill);
      const pulse = 0.72 + Math.sin(engine.time * 5.5) * 0.28;
      const { wx, wy } = hexWorld(active.x, active.y, tile);
      this.activeTurnGlow.visible = true;
      this.activeTurnGlow.position.set(wx, -wy, 0.45);
      this.activeTurnGlow.scale.setScalar(tile * (2.45 + pulse * 0.32));
      this.activeTurnGlowMaterial.color.set(active.player ? 0xd6a12a : 0xd25436);
      this.activeTurnGlowMaterial.opacity = active.player ? Math.min(1, (0.32 + pulse * 0.18) * 1.5) : 0.72;
      // ADDITIVE ONLY — see activeTurnShadowCatcher's own field comment. `wx,wy` above (from
      // hexWorld) is the tile's plain grid-cell center, which is NOT where a standing unit's feet
      // actually are — syncUnits positions the real per-unit shadow-caster box at
      // `anchor.worldX + v.sway, -(anchor.worldY + v.footY)` instead (footY nudges it toward the
      // tile's visual "front"), so this has to use that same computation, not wx/wy, or it lands
      // in the wrong spot relative to the character. None of the hex/glow lines above this are
      // read from or written to.
      const activeUnit = engine.units.find((u) => u.x === active.x && u.y === active.y && u.alive);
      if (activeUnit && !getDevGfx().contactShadows) {
        const unitAnchor = engine.unitAnchor(activeUnit);
        const v = engine.unitVisual(activeUnit, tile);
        this.activeTurnShadowCatcher.visible = true;
        this.activeTurnShadowCatcher.position.set(unitAnchor.worldX + v.sway, -(unitAnchor.worldY + v.footY), 0.51);
        this.activeTurnShadowCatcher.scale.set(tile * 1.1, tile * 1.1, 1);
      } else {
        this.activeTurnShadowCatcher.visible = false;
      }
    } else {
      this.activeTurnGlow.visible = false;
      this.activeTurnShadowCatcher.visible = false;
    }
    // The mouse-selection hex, drawn here instead of on the Canvas2D units shim (see
    // BattleEngine.renderUnitsAndOverlays' skipCursorHex) so it lands at this same z=0.5 —
    // genuinely behind decorations/units instead of on a canvas stacked above them.
    const cur = engine.hover ?? engine.cursor;
    const blocked = !TERRAIN[tileAt(engine.tiles, engine.cols, cur.x, cur.y)].passable;
    place(cur.x, cur.y, blocked ? "rgba(255,90,72,0.28)" : "rgba(240,235,227,0.16)");
    for (; idx < this.overlayMeshPool.length; idx++) this.overlayMeshPool[idx]!.visible = false;
    for (; glowIdx < this.overlayGlowPool.length; glowIdx++) this.overlayGlowPool[glowIdx]!.visible = false;
  }

  /** Call once per frame in place of BattleEngine.renderGround — updateCameraLayout runs the
   * exact same camera/visibility bookkeeping renderGround always did (see that method's own
   * comment), just without drawing through the Canvas2D shim afterward. */
  render(cssW: number, cssH: number): void {
    const tile = this.engine.updateCameraLayout(cssW, cssH);
    this.syncBackdrop(cssW, cssH, tile);
    this.ensureBuilt(tile);
    this.syncDirtyTiles();
    this.ensureDecorBuilt(tile);
    this.syncDecorVisibility();
    this.syncOverlay(tile);
    this.syncUnits(tile);
    this.applyDevGfx();
    // MILESTONE 3 — dt derived locally (render() itself only ever receives cssW/cssH, see this
    // method's own comment) since the mist noise drift and particle GPU animation are the only
    // things in this file that need real elapsed time rather than per-frame engine state.
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;
    // The camera moves; the tiles never do — see module comment. This is the one line that
    // has to run every frame for panning/zooming to work. Y is `-camY - cssH` to match the
    // mesh placement's own Y-negation (see module comment) — verified numerically to
    // reproduce BattleEngine's cx/cy screen-pixel formula exactly.
    this.camera.position.set(this.engine.camX, -this.engine.camY - cssH, 100);
    this.atmosphere.sync(this.engine, tile, dt, this.sunLight, this.hemiLight, {
      cssW,
      cssH,
      camX: this.engine.camX,
      camY: this.engine.camY,
    });
    // MILESTONE 2 — the sun has to re-aim every frame too, for the same reason the camera does:
    // the shadow-caster boxes are fixed in world space, only the view of them pans.
    this.updateSun(cssW, cssH, this.engine.camX, this.engine.camY);
    // Bloom applies to the WHOLE scene now, per direct instruction — no more per-object
    // opt-in via a bloom layer. bloomComposer renders the real scene straight through
    // UnrealBloomPass (which extracts/blurs whatever clears BLOOM_THRESHOLD on its own),
    // finalComposer renders it again normally and additively mixes that bloom texture back
    // in via mixPass. See BLOOM_THRESHOLD's own comment for why it's tuned much higher than
    // the old selective-only value now that everything bright enough can bloom.
    this.bloomComposer.render();
    this.finalComposer.render();
  }

  /** Dev Controls toggles (see devGfx.ts) — read every frame so a flip applies immediately. */
  private applyDevGfx(): void {
    const gfx = getDevGfx();
    if (this.sunLight.castShadow !== gfx.realShadows) this.sunLight.castShadow = gfx.realShadows;
    this.sunLight.shadow.radius = gfx.softShadows ? SHADOW_RADIUS_SOFT : SHADOW_RADIUS_HARD;
    this.contactShadowGroup.visible = gfx.contactShadows;
  }

  dispose(): void {
    // MILESTONE 4 — EffectComposer.dispose() only frees its own two ping-pong render targets and
    // internal copy pass, NOT the passes added to it — bloomPass owns several render targets of
    // its own (bright-pass + per-mip horizontal/vertical blur buffers) that leak without this.
    this.bloomComposer.dispose();
    this.finalComposer.dispose();
    this.bloomPass.dispose();
    this.atmosphere.dispose();
    this.hexGeo.dispose();
    this.quadGeo.dispose();
    this.backdropGeometry.dispose();
    this.backdropMaterial.dispose();
    this.backdropTexture?.dispose();
    this.fallbackMaterial.dispose();
    for (const mat of this.materialCache.values()) {
      mat.map?.dispose();
      mat.dispose();
    }
    for (const mat of this.decorMatCache.values()) {
      mat.map?.dispose();
      mat.dispose();
    }
    // decorShadowMatCache/unit shadowMaterial share their texture with decorMatCache/unitTexCache
    // (see decorShadowMaterialFor's/the shadow-material creation's own comment) — the texture is
    // already disposed above/below, so only the material itself needs disposing here.
    for (const mat of this.decorShadowMatCache.values()) mat.dispose();
    for (const tex of this.unitTexCache.values()) tex.dispose();
    for (const entry of this.unitEntries.values()) {
      entry.material.dispose();
      entry.shadowMaterial.dispose();
      entry.contactMaterial.dispose();
    }
    for (const mat of this.overlayMatCache.values()) mat.dispose();
    for (const glow of this.overlayGlowPool) (glow.material as THREE.SpriteMaterial).dispose();
    this.activeTurnGlowMaterial.dispose();
    this.activeTurnGlowTexture.dispose();
    this.activeTurnShadowCatcherMaterial.dispose();
    this.activeTurnShadowCatcherTexture.dispose();
    this.contactShadowTexture.dispose();
    this.renderer.dispose();
  }
}
