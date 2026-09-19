import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Check, ChevronLeft, Lock, MapPin, SlidersHorizontal, Volume2, VolumeX, X, ZoomIn, ZoomOut } from "lucide-react";
import { missionsForLocation } from "./mapstore";
import type { EquipSlot, Mission, PotionId, SaveData, WorldLocation } from "./types";
import { PartyInventoryOverlay } from "./InventoryScreens";
import { heroRecruited } from "./data";
import { GoldAmount } from "./GoldAmount";
import { getAudioVolumes, setCutsceneVolume, setMusicVolume, setSfxVolume, sfxPlay, unlockAudio } from "./audio";
import { canStepOverworld, hexToWorld, isOverworldCell, locationExpired, neighborsOf, OVERWORLD_START_HEX, type OverworldEvent, worldToHex } from "./overworld";
import { HungerBar } from "./HungerBar";
import { portraitFor } from "./assets";
import { key } from "./pathfinding";
import { MapLoadingOverlay, useMapLoading } from "./MapLoadingOverlay";

export type LocationStatus = "locked" | "available" | "done";

const ZOOM_STOPS = [70, 90, 110, 130];

/** Idle-breathing frames of the MC's own sprite (public/game/sprites/Kael_Final/kael-final-002),
 * the same art the battle engine plays as Kael — see assets.ts's "kaelFinal" entry. Only every
 * third of the 36 captured frames is used: plenty smooth at the size this renders (a small
 * JRPG-style overworld token), for a third of the image requests. */
const KAEL_MARKER_FRAMES = Array.from({ length: 12 }, (_, i) => 1 + i * 3);

function KaelMarker({ facingLeft }: { facingLeft: boolean }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setFrame((f) => (f + 1) % KAEL_MARKER_FRAMES.length), 110);
    return () => window.clearInterval(id);
  }, []);
  return (
    <img
      src={`/game/sprites/Kael_Final/kael-final-002/${KAEL_MARKER_FRAMES[frame]}.png?v=kael-final-002`}
      alt=""
      draggable={false}
      className="h-12 w-auto object-contain select-none drop-shadow-[0_2px_3px_rgba(0,0,0,0.6)]"
      style={{ transform: facingLeft ? "scaleX(-1)" : undefined }}
    />
  );
}

/** The RPG map: same background art and pan/zoom viewport as the classic map, but travel is
 * hex-by-hex instead of jumping straight to any unlocked location. The hex grid itself
 * (src/game/overworld.ts) is never drawn — only the party's current position (a small Kael
 * sprite) and the immediate neighbors it can step to are ever shown as interactive. Every
 * existing location pin still renders exactly where the classic map puts it; only whether a
 * click on it does anything depends on reachability this turn. */
export function OverworldMapScreen({
  locations,
  status,
  missionStatus,
  ember,
  test,
  muted,
  onMute,
  overworldPos,
  gameClock,
  rations,
  hungerStreak,
  heroHunger,
  save,
  onUseRation,
  onUseRationAll,
  onEquipWeapon,
  onEquipItem,
  onUsePotion,
  onDiscardWeapon,
  onDiscardEquipment,
  onDiscardRation,
  onDiscardBagItem,
  inventoryRequestHero,
  inventoryRequestView,
  onInventoryRequestHandled,
  onOpenStatus,
  event,
  onDismissEvent,
  onStep,
  onTeleport,
  onBack,
  onPick,
}: {
  locations: WorldLocation[];
  status: (loc: WorldLocation) => LocationStatus;
  missionStatus: (missionId: string) => LocationStatus;
  ember: number;
  test: boolean;
  muted: boolean;
  onMute: () => void;
  overworldPos: { col: number; row: number };
  gameClock: number;
  rations: number;
  hungerStreak: number;
  heroHunger: Record<string, number>;
  save: SaveData;
  onUseRation: (hero: string) => void;
  onUseRationAll?: (heroes: string[]) => number;
  /** Wired into the Mochila/Paperdoll's own equip picker — omitted for a while, which left
   * every tap there a silent no-op (see PartyInventoryOverlay below). */
  onEquipWeapon?: (hero: string, weaponId: string) => void;
  onEquipItem?: (hero: string, slot: EquipSlot, itemId: string | null) => void;
  onUsePotion?: (hero: string, kind: PotionId) => void;
  onDiscardWeapon?: (weaponId: string) => void;
  onDiscardEquipment?: (itemId: string) => void;
  onDiscardRation?: () => void;
  onDiscardBagItem?: (hero: string, kind: PotionId | "lockpick") => void;
  inventoryRequestHero?: string | null;
  inventoryRequestView?: "backpack" | "equipment";
  onInventoryRequestHandled?: () => void;
  onOpenStatus: (hero: string) => void;
  event: OverworldEvent | null;
  onDismissEvent: () => void;
  /** Commits one hex step (or a no-op re-click on the current hex) — day/ration/recovery
   * math lives in overworld.ts's stepOverworld, called by the parent. */
  onStep: (col: number, row: number) => void;
  /** Modo teste only: jumps straight to a non-adjacent pin, no day/supply cost. Never called
   * for a walkable (adjacent) pin — those always go through onStep instead, so the day
   * clock and rations stay visible and testable even in test mode. */
  onTeleport?: (col: number, row: number) => void;
  onBack: () => void;
  onPick: (missionId: string) => void;
}) {
  const [open, setOpen] = useState<WorldLocation | null>(null);
  const [movementOpen, setMovementOpen] = useState(false);
  const [confirmVau, setConfirmVau] = useState(false);
  const [inventoryHero, setInventoryHero] = useState<string | null>(null);
  const stepLock = useRef(false);
  useEffect(() => {
    if (!inventoryRequestHero) return;
    setInventoryHero(inventoryRequestHero);
    onInventoryRequestHandled?.();
  }, [inventoryRequestHero, onInventoryRequestHandled]);
  useEffect(() => {
    stepLock.current = false;
  }, [overworldPos.col, overworldPos.row]);
  useEffect(() => {
    const cancel = (e: KeyboardEvent) => { if (e.key === "Escape") setMovementOpen(false); };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, []);
  const [artOk, setArtOk] = useState(true);
  const mapLoading = useMapLoading();
  const [flashId, setFlashId] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [zoomIdx, setZoomIdx] = useState(ZOOM_STOPS.length - 1);
  const [audioSettingsOpen, setAudioSettingsOpen] = useState(false);
  const [audioLevels, setAudioLevels] = useState(() => getAudioVolumes());
  const [dragging, setDragging] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number; moved: boolean } | null>(null);
  const centerFracRef = useRef({ x: 0.5, y: 0.5 });

  // Which way Kael last actually moved — kept across steps (not reset when standing still),
  // so re-clicking the current hex or arriving straight-up/down doesn't suddenly flip him.
  const [facingLeft, setFacingLeft] = useState(false);
  const prevPosRef = useRef(overworldPos);
  useEffect(() => {
    const prev = prevPosRef.current;
    if (overworldPos.col !== prev.col) setFacingLeft(overworldPos.col < prev.col);
    prevPosRef.current = overworldPos;
  }, [overworldPos.col, overworldPos.row]);

  const recenterOn = (fx: number, fy: number) => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, fx * el.scrollWidth - el.clientWidth / 2));
    el.scrollTop = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, fy * el.scrollHeight - el.clientHeight / 2));
  };
  const captureCenterFrac = () => {
    const el = viewportRef.current;
    if (!el || el.scrollWidth === 0 || el.scrollHeight === 0) return;
    centerFracRef.current = {
      x: (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth,
      y: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight,
    };
  };

  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) return;
    recenterOn(centerFracRef.current.x, centerFracRef.current.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomIdx]);

  // Opens centered on the party's current hex, same idea as the classic map centering on
  // centerLocationId — just derived from overworldPos instead. Mount-only, so panning
  // afterward isn't fought on every step.
  useEffect(() => {
    const world = hexToWorld(overworldPos.col, overworldPos.row);
    centerFracRef.current = { x: world.x / 100, y: world.y / 100 };
    recenterOn(centerFracRef.current.x, centerFracRef.current.y);
    mounted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch") return;
    const el = viewportRef.current;
    if (!el) return;
    dragRef.current = { x: e.clientX, y: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, moved: false };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = viewportRef.current;
    if (!d || !el) return;
    if (e.pointerType === "mouse" && e.buttons === 0) {
      dragRef.current = null;
      setDragging(false);
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      d.moved = true;
      el.setPointerCapture(e.pointerId);
    }
    if (!d.moved) return;
    el.scrollLeft = d.scrollLeft - dx;
    el.scrollTop = d.scrollTop - dy;
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = viewportRef.current;
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    setDragging(false);
  };
  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (dragRef.current?.moved) {
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = null;
    }
  };

  const showHint = (text: string) => {
    setHint(text);
    window.setTimeout(() => setHint((h) => (h === text ? null : h)), 1200);
  };

  // Everything the party can step to right now: its own hex (re-clicking it just reopens
  // whatever's there, no day spent — see stepOverworld's same-hex no-op) plus its six
  // neighbors. The only adjacency rule the UI is allowed to know about.
  const reachable = useMemo(() => {
    const set = new Set<string>();
    set.add(key(overworldPos.col, overworldPos.row));
    for (const n of neighborsOf(overworldPos.col, overworldPos.row)) set.add(key(n.x, n.y));
    return set;
  }, [overworldPos.col, overworldPos.row]);

  const wildDots = useMemo(
    () =>
      neighborsOf(overworldPos.col, overworldPos.row)
        .filter((n) => isOverworldCell(n.x, n.y) && canStepOverworld(save, { x: overworldPos.col, y: overworldPos.row }, n, test))
        .map((n) => ({ ...n, world: hexToWorld(n.x, n.y) })),
    [overworldPos.col, overworldPos.row, test],
  );

  // Standing exactly on a location's hex snaps the marker to that location's own authored
  // x/y (sub-hex precision) instead of the hex-center approximation, so Kael visibly lands
  // right on the pin rather than somewhere nearby within the same hex.
  const standingOn = useMemo(
    () => locations.find((l) => { const h = worldToHex(l.x, l.y); return h.x === overworldPos.col && h.y === overworldPos.row; }),
    [locations, overworldPos.col, overworldPos.row],
  );
  const partyWorld = hexToWorld(overworldPos.col, overworldPos.row);

  // Fog of war: every hex the party has ever stood on (see stepOverworld in overworld.ts).
  // The Inn is exempt from it entirely — always shown regardless — every other pin only
  // shows once its own hex is in this set. Test mode ignores fog like it ignores every
  // other travel restriction on this map.
  const exploredSet = useMemo(() => new Set(save.exploredHexes ?? []), [save.exploredHexes]);
  const isExplored = (loc: WorldLocation) => {
    if (test || loc.id === "estalagem" || loc.id === standingOn?.id) return true;
    const h = worldToHex(loc.x, loc.y);
    return exploredSet.has(key(h.x, h.y));
  };
  /** Percent-of-image reveal radius around one explored hex — a bit more than one hex's own
   * OVERWORLD_HEX_SIZE so the cleared patch reads as "the area around here," not just the
   * single dot the party stood on. */
  const FOG_REVEAL_RADIUS = 9;

  // Standing at the western edge with O Vau still unfought — clicking Kael here has nothing
  // to walk to (canStepOverworld keeps that edge closed until Vau is won) and nowhere to open
  // a chapter list either, so it asks outright instead of just toggling an empty move prompt.
  const atStartPreVau =
    !test && !save.completed.includes("vau") && overworldPos.col === OVERWORLD_START_HEX.x && overworldPos.row === OVERWORLD_START_HEX.y;

  const walkTo = (col: number, row: number) => {
    if (!movementOpen || stepLock.current || !isOverworldCell(col, row)) return;
    stepLock.current = true;
    setMovementOpen(false);
    onStep(col, row);
    // Walking onto a location's hex only arrives there — it no longer pops the mission
    // list open on its own. The pin now reads as "standing here" (see standingOn) and
    // waits for its own click, same as any other pin, so arriving never yanks a panel
    // over the map before the player has looked around.
    //
    // One scripted exception: Bosque Morto is an ambush, not a chapter the player opts into
    // from a list — it finds the party the moment they set out from the ford, so their very
    // first step after O Vau (and before Bosque is played) launches it directly, no click
    // needed. Never in test mode: testing needs to walk and map every hex freely, not get
    // funneled into a forced battle.
    if (!test && save.completed.includes("vau") && !save.completed.includes("bosque")) {
      onPick("bosque");
    }
  };

  const enterLocation = (loc: WorldLocation, st: LocationStatus) => {
    if (locationExpired(loc, gameClock)) {
      showHint("Prazo esgotado por aqui.");
      return;
    }
    if (st === "locked") {
      setFlashId(loc.id);
      window.setTimeout(() => setFlashId((f) => (f === loc.id ? null : f)), 500);
      return;
    }
    const missions = missionsForLocation(loc);
    if (missions.length > 1) {
      setOpen(loc);
      return;
    }
    if (missions[0]) onPick(missions[0].id);
  };

  return (
    <section className="relative h-dvh min-h-0 flex flex-col overflow-hidden bg-bg">
      <div className="absolute inset-0" style={{ background: "radial-gradient(ellipse at 30% 20%, #241f19 0%, #0c0b0a 70%)" }} />

      <header className="relative z-20 flex items-center gap-3 px-4 pt-[max(1rem,env(safe-area-inset-top))] pb-4 flex-wrap">
        <button type="button" onClick={onBack} className="size-10 grid place-items-center rounded-md border border-border bg-bg/70" aria-label="Voltar">
          <ChevronLeft className="size-5" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm uppercase tracking-[0.18em] text-muted">{test ? "Modo teste" : "Campanha"} · RPG</p>
          <h1 className="font-display text-3xl leading-none">Mapa</h1>
        </div>
        <p className="text-sm text-muted border border-border rounded-md px-2 py-1 bg-bg/70">Dia <span className="text-fg tabular-nums">{gameClock}</span></p>
        <p className="text-sm text-muted border border-border rounded-md px-2 py-1 bg-bg/70">Rações <span className="text-fg tabular-nums">{rations}</span></p>
        {hungerStreak > 0 && (
          <p className="text-sm border rounded-md px-2 py-1 bg-bg/70 border-danger/60 text-danger">
            Fome <span className="tabular-nums">{hungerStreak}d</span>
          </p>
        )}
        {onUseRationAll && (
          <button
            type="button"
            className="h-9 px-3 rounded-md border border-border bg-bg/70 text-sm"
            onClick={() => {
              const heroes = (["Kael", "Neera", "Voss", "Salazar", "Aldric", "Malrec"] as const).filter(
                (name) => test || heroRecruited(name, save.completed),
              );
              const fed = onUseRationAll(heroes);
              showHint(
                fed === 0
                  ? "Ninguém comeu — sem rações ou já saciados."
                  : fed === heroes.length
                    ? "Todos comeram."
                    : `${fed} comeram — rações não deram pros demais.`,
              );
            }}
          >
            Alimentar todos
          </button>
        )}
        <button type="button" onClick={onMute} className="size-9 grid place-items-center rounded-md border border-border bg-bg/70" aria-label="Som">
          {muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
        </button>
        <div className="relative">
          <button
            type="button"
            onClick={() => setAudioSettingsOpen((o) => !o)}
            className="size-9 grid place-items-center rounded-md border border-border bg-bg/70"
            aria-label="Volumes"
            aria-expanded={audioSettingsOpen}
          >
            <SlidersHorizontal className="size-4" />
          </button>
          {audioSettingsOpen && (
            <div className="absolute right-0 top-full mt-2 w-64 rounded-md border border-border bg-bg/95 p-3 flex flex-col gap-3 shadow-lg shadow-bg/40 z-20">
              <label className="flex flex-col gap-1.5">
                <span className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-muted">
                  Música <span className="tabular-nums text-fg">{Math.round(audioLevels.music * 100)}%</span>
                </span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={audioLevels.music}
                  onChange={(e) => {
                    const music = Number(e.target.value);
                    setMusicVolume(music);
                    setAudioLevels((levels) => ({ ...levels, music }));
                  }}
                  aria-label="Volume da música"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-muted">
                  Efeitos <span className="tabular-nums text-fg">{Math.round(audioLevels.sfx * 100)}%</span>
                </span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={audioLevels.sfx}
                  onChange={(e) => {
                    const sfx = Number(e.target.value);
                    setSfxVolume(sfx);
                    setAudioLevels((levels) => ({ ...levels, sfx }));
                  }}
                  aria-label="Volume dos efeitos"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="flex items-center justify-between text-xs uppercase tracking-[0.14em] text-muted">
                  Cutscenes <span className="tabular-nums text-fg">{Math.round(audioLevels.cutscene * 100)}%</span>
                </span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={audioLevels.cutscene}
                  onChange={(e) => {
                    const cutscene = Number(e.target.value);
                    setCutsceneVolume(cutscene);
                    setAudioLevels((levels) => ({ ...levels, cutscene }));
                  }}
                  aria-label="Volume das cutscenes"
                />
              </label>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted">Música em 0% deixa só os efeitos.</p>
                <button
                  type="button"
                  onClick={() => {
                    unlockAudio();
                    sfxPlay.magicAttack();
                  }}
                  className="h-8 px-3 rounded-md border border-border bg-bg/70 text-xs uppercase tracking-[0.1em]"
                >
                  Testar
                </button>
              </div>
            </div>
          )}
        </div>
        <p className="text-sm text-muted border border-border rounded-md px-2 py-1 bg-bg/70"><GoldAmount amount={ember} /></p>
      </header>

      <div
        ref={viewportRef}
        className={`relative z-10 flex-1 min-h-0 overflow-auto overscroll-contain touch-pan-x touch-pan-y select-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        style={{ WebkitOverflowScrolling: "touch" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={endDrag}
        onClickCapture={onClickCapture}
      >
        <div className="relative inline-block m-2" style={{ width: artOk ? `${ZOOM_STOPS[zoomIdx]}%` : undefined }}>
          {artOk ? (
            <img
              src="/game/assets/world-map.jpg"
              alt=""
              className="block w-full h-auto rounded-lg select-none"
              draggable={false}
              onError={() => { setArtOk(false); mapLoading.finish(); }}
              onLoad={() => {
                recenterOn(centerFracRef.current.x, centerFracRef.current.y);
                window.requestAnimationFrame(() => window.requestAnimationFrame(mapLoading.finish));
              }}
            />
          ) : (
            <div className="w-[70dvw] h-[70dvh] max-w-md" />
          )}
          {artOk && !test && (
            // Fog of war: dark everywhere except a soft radius around every hex the party
            // has ever stood on (see exploredSet above). Test mode skips this like it skips
            // every other travel restriction on this map — testing needs the whole map
            // visible, not walked hex by hex. An SVG mask rather than CSS mask-composite:
            // browser support for compositing many stacked mask layers is inconsistent,
            // while an SVG <mask> just paints shapes on top of each other, so it works the
            // same everywhere.
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
              <defs>
                <radialGradient id="ow-fog-reveal">
                  <stop offset="0%" stopColor="#000" stopOpacity="1" />
                  <stop offset="65%" stopColor="#000" stopOpacity="1" />
                  <stop offset="100%" stopColor="#000" stopOpacity="0" />
                </radialGradient>
                <mask id="ow-fog-mask" maskContentUnits="userSpaceOnUse">
                  <rect x="0" y="0" width="100" height="100" fill="#fff" />
                  {[...exploredSet].map((hexKey) => {
                    const [hx, hy] = hexKey.split(",").map(Number);
                    if (!Number.isFinite(hx) || !Number.isFinite(hy)) return null;
                    const p = hexToWorld(hx, hy);
                    return <circle key={hexKey} cx={p.x} cy={p.y} r={FOG_REVEAL_RADIUS} fill="url(#ow-fog-reveal)" />;
                  })}
                </mask>
              </defs>
              <rect x="0" y="0" width="100" height="100" fill="rgba(8,6,4,0.78)" mask="url(#ow-fog-mask)" />
            </svg>
          )}
          <div className="absolute inset-0">
            {locations.filter(isExplored).map((loc) => {
              const st = status(loc);
              const missions = missionsForLocation(loc);
              const multi = missions.length > 1;
              const hex = worldToHex(loc.x, loc.y);
              const walkable = reachable.has(key(hex.x, hex.y));
              // Modo teste: every pin is clickable, no walking required — testing needs to
              // jump straight to any location, the same freedom the classic map already
              // gives it. A walkable (adjacent) pin still walks normally even in test mode,
              // so the day-clock/rations math stays visible and testable there too; only a
              // distant pin gets the free teleport.
              const isReachable = test || walkable;
              const expired = locationExpired(loc, gameClock);
              return (
                <button
                  key={loc.id}
                  type="button"
                  onClick={() => {
                    if (loc.id === standingOn?.id) { enterLocation(loc, st); return; }
                    if (walkable) { walkTo(hex.x, hex.y); return; }
                    if (!isReachable) {
                      showHint("Ande até lá primeiro.");
                      return;
                    }
                    onTeleport?.(hex.x, hex.y);
                    enterLocation(loc, st);
                  }}
                  className={`group absolute -translate-x-1/2 -translate-y-1/2 ${isReachable ? "" : "opacity-70"}`}
                  style={{ left: `${loc.x}%`, top: `${loc.y}%` }}
                  aria-label={st === "locked" ? `${loc.name} (bloqueado)` : loc.name}
                >
                  <span
                    className={`relative size-10 rounded-full border-2 grid place-items-center bg-bg/80 transition-transform group-hover:scale-110 group-active:scale-95 ${
                      st === "locked"
                        ? `border-border opacity-50 ${loc.id === flashId ? "locked-flash" : ""}`
                        : st === "done"
                          ? "border-accent"
                          : missions.some((m) => m.hub)
                            ? "inn-open"
                            : "border-accent"
                    } ${expired ? "border-dashed" : ""}`}
                  >
                    {st === "locked" ? (
                      <Lock className="size-4 text-muted" />
                    ) : st === "done" ? (
                      <Check className="size-4 text-accent" />
                    ) : (
                      <MapPin className="size-4 text-accent" />
                    )}
                    {multi && (
                      <span className="absolute -top-1.5 -right-1.5 size-4 rounded-full bg-bg border border-border text-[10px] leading-none grid place-items-center text-fg/90">
                        {missions.length}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}

            {/* Wild-hex stepping stones: the invisible grid's only visible trace, and only
                right around the party — not pre-authored pins, so they appear and vanish as
                it moves instead of cluttering the whole map. */}
            {movementOpen && wildDots.map((dot) => (
              <button
                key={key(dot.x, dot.y)}
                type="button"
                onClick={() => walkTo(dot.x, dot.y)}
                className="overworld-step absolute -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${dot.world.x}%`, top: `${dot.world.y}%`, width: `${Math.sqrt(3) * 5}%`, height: "10%" }}
                aria-label={`Andar para ${dot.x}, ${dot.y} · 1 dia`}
              >
                <span>1 dia</span>
              </button>
            ))}

            {/* The party's own marker — a tiny idle Kael, sliding hex to hex as the party
                steps (the transition is what reads as "movement": there's no walk-cycle art
                for this sprite, just the idle loop, so distance covered does the talking). */}
            <button
              type="button"
              aria-label={atStartPreVau ? "Entrar na missão" : "Mover Kael"}
              aria-expanded={movementOpen}
              onClick={() => {
                if (atStartPreVau) {
                  setConfirmVau(true);
                  return;
                }
                setMovementOpen((value) => !value);
              }}
              className="absolute z-20 -translate-x-1/2 -translate-y-full min-w-11 min-h-11 transition-all duration-500 ease-in-out focus-visible:outline-2 focus-visible:outline-accent"
              style={{ left: `${partyWorld.x}%`, top: `${partyWorld.y}%` }}
            >
              <KaelMarker facingLeft={facingLeft} />
            </button>
          </div>
        </div>
      </div>

      {hint && (
        <div className="absolute z-30 top-24 left-1/2 -translate-x-1/2 bg-bg/90 border border-border rounded-md px-3 py-1.5 text-xs text-fg">
          {hint}
        </div>
      )}

      <div className="map-party-panel absolute z-20 bottom-4 left-4 rounded-lg border border-border p-3 max-w-[calc(100%-6rem)]">
        <p className="text-xs text-muted mb-2" aria-live="polite">
          {atStartPreVau ? "Clique em Kael para entrar na missão" : movementOpen ? "Escolha um hexágono · 1 dia" : "Clique em Kael para mover"}
        </p>
        <div className="flex gap-3">
          {([['Kael', 'kaelFinal'], ['Neera', 'neera'], ['Voss', 'voss'], ['Salazar', 'salazar'], ['Aldric', 'aldric'], ['Malrec', 'malrec']] as const).filter(([name]) => test || heroRecruited(name, save.completed)).map(([name, sprite]) => (
            <div key={name} className="w-10" title={name}>
              <button type="button" aria-label={`Inventário de ${name}`} onClick={() => setInventoryHero(name)} className="min-h-11">
                <img src={portraitFor(sprite).src} alt={name} className="w-10 h-12 object-cover rounded" />
              </button>
              <HungerBar name={name} value={heroHunger[name]} />
            </div>
          ))}
        </div>
        {standingOn && <button className="text-xs text-accent mt-2 min-h-11" onClick={() => enterLocation(standingOn, status(standingOn))}>Explorar {standingOn.name}</button>}
      </div>

      {event && (
        <div className="absolute inset-0 z-40 ember-veil flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Evento da viagem">
          <div className="w-full max-w-sm bg-surface border border-border rounded-lg px-5 py-4 text-sm text-fg shadow-lg shadow-bg/40">
            <p>{event.text}</p>
            <button type="button" onClick={onDismissEvent} className="mt-4 h-11 w-full rounded-md border border-border bg-bg text-sm font-medium">
              OK
            </button>
          </div>
        </div>
      )}

      {confirmVau && (
        <div className="absolute inset-0 z-40 ember-veil flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Entrar na missão">
          <div className="w-full max-w-sm bg-surface border border-border rounded-lg px-5 py-4 text-sm text-fg shadow-lg shadow-bg/40">
            <p className="font-display text-xl text-center mb-4">Entrar na missão?</p>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setConfirmVau(false)}
                className="h-11 flex-1 rounded-md border border-border bg-bg text-sm font-medium"
              >
                Não
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmVau(false);
                  onPick("vau");
                }}
                className="h-11 flex-1 rounded-md border border-accent bg-accent/20 text-sm font-medium"
              >
                Sim
              </button>
            </div>
          </div>
        </div>
      )}

      {artOk && (
        <div className="absolute z-20 bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 flex flex-col gap-1 bg-bg/85 border border-border rounded-lg p-1">
          <button
            type="button"
            onClick={() => {
              captureCenterFrac();
              setZoomIdx((i) => Math.min(ZOOM_STOPS.length - 1, i + 1));
            }}
            disabled={zoomIdx >= ZOOM_STOPS.length - 1}
            className="size-11 grid place-items-center rounded-md disabled:opacity-30 active:bg-surface-2"
            aria-label="Aproximar"
          >
            <ZoomIn className="size-5" />
          </button>
          <div className="text-center text-[10px] tabular-nums text-muted py-0.5">
            {ZOOM_STOPS.length - zoomIdx}/{ZOOM_STOPS.length}
          </div>
          <button
            type="button"
            onClick={() => {
              captureCenterFrac();
              setZoomIdx((i) => Math.max(0, i - 1));
            }}
            disabled={zoomIdx <= 0}
            className="size-11 grid place-items-center rounded-md disabled:opacity-30 active:bg-surface-2"
            aria-label="Afastar"
          >
            <ZoomOut className="size-5" />
          </button>
        </div>
      )}

      <MapLoadingOverlay progress={mapLoading.progress} visible={mapLoading.visible} />

      {open && (
        <LocationPanel
          location={open}
          missions={missionsForLocation(open)}
          missionStatus={missionStatus}
          test={test}
          onPick={(id) => {
            setOpen(null);
            onPick(id);
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {inventoryHero && (
        <PartyInventoryOverlay
          heroName={inventoryHero}
          classId={mapHeroClass(inventoryHero, save)}
          save={save}
          test={test}
          initialView={inventoryRequestView ?? "backpack"}
          onUseRation={onUseRation}
          onUseRationAll={onUseRationAll}
          onEquipWeapon={onEquipWeapon}
          onEquipItem={onEquipItem}
          onUsePotion={onUsePotion}
          onDiscardWeapon={onDiscardWeapon}
          onDiscardEquipment={onDiscardEquipment}
          onDiscardRation={onDiscardRation}
          onDiscardBagItem={onDiscardBagItem}
          onOpenStatus={(hero) => {
            setInventoryHero(null);
            onOpenStatus(hero);
          }}
          onClose={() => setInventoryHero(null)}
        />
      )}
    </section>
  );
}

const MAP_HERO_CLASS = { Kael: "swordsman", Neera: "archer", Voss: "mage", Salazar: "healer", Aldric: "aldric", Malrec: "conjurer" } as const;

function mapHeroClass(hero: string, save: SaveData) {
  return save.promotions[hero] ?? MAP_HERO_CLASS[hero as keyof typeof MAP_HERO_CLASS] ?? "swordsman";
}

function LocationPanel({
  location,
  missions,
  missionStatus,
  test,
  onPick,
  onClose,
}: {
  location: WorldLocation;
  missions: Mission[];
  missionStatus: (missionId: string) => LocationStatus;
  test: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [flashId, setFlashId] = useState<string | null>(null);
  return (
    <div
      className="absolute inset-0 z-40 bg-bg/45 backdrop-blur-[3px] flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md max-h-[80dvh] overflow-y-auto bg-surface/95 border border-border rounded-xl p-5">
        <div className="flex items-start justify-between gap-3 mb-4">
          <p className="font-display text-xl leading-tight">{location.name}</p>
          <button type="button" onClick={onClose} className="size-8 grid place-items-center rounded-md border border-border" aria-label="Fechar">
            <X className="size-4" />
          </button>
        </div>
        <ol className="flex flex-col gap-2">
          {missions.map((m, i) => {
            const st = missionStatus(m.id);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (st === "locked") {
                      setFlashId(m.id);
                      window.setTimeout(() => setFlashId((f) => (f === m.id ? null : f)), 500);
                      return;
                    }
                    onPick(m.id);
                  }}
                  aria-label={st === "locked" ? `${m.title} (bloqueado)` : undefined}
                  className={`w-full text-left rounded-xl border bg-surface px-4 py-3 ${
                    st === "locked" ? `opacity-40 border-border ${m.id === flashId ? "locked-flash" : ""}` : "border-border"
                  }`}
                >
                  <p className="text-sm uppercase tracking-[0.16em] text-muted flex items-center gap-1.5">
                    {st === "locked" && <Lock className="size-3" />}
                    {st === "done" && <Check className="size-3 text-accent" />}
                    {String(i + 1).padStart(2, "0")} · {m.place}
                    {st === "done" ? " · feito" : ""}
                  </p>
                  <p className="font-display text-2xl">{m.title}</p>
                  <p className="text-base text-muted">{m.objective}</p>
                </button>
              </li>
            );
          })}
        </ol>
        {test && <p className="mt-3 text-xs text-muted">Modo teste: todos os capítulos estão abertos.</p>}
      </div>
    </div>
  );
}
