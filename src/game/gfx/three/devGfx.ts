/** Dev-only graphics toggles for ThreeBattleRenderer, flipped from the Dev Controls screen
 * (Modo teste → Dev Controls) and persisted per-browser in localStorage. The renderer reads
 * getDevGfx() every frame, so a change applies to the next battle frame with no reload. */
export interface DevGfxSettings {
  /** The sun's real cast shadows (units + props) at all — off gives a clean A/B baseline. */
  realShadows: boolean;
  /** Widens the PCF filter radius so shadow edges soften instead of stair-stepping.
   * (PCFSoftShadowMap was removed in this Three.js version — radius is the knob now.) */
  softShadows: boolean;
  /** A short, soft dark footprint under every unit's feet, independent of the shadow map —
   * the real cast shadow never quite reaches the feet (see activeTurnShadowCatcher's comment). */
  contactShadows: boolean;
}

const KEY = "emberash:devGfx";
const DEFAULTS: DevGfxSettings = { realShadows: true, softShadows: true, contactShadows: true };

function load(): DevGfxSettings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<DevGfxSettings>) };
  } catch {
    // localStorage unavailable or corrupt — defaults
  }
  return { ...DEFAULTS };
}

let current: DevGfxSettings = load();
const listeners = new Set<() => void>();

export function getDevGfx(): DevGfxSettings {
  return current;
}

export function setDevGfx(patch: Partial<DevGfxSettings>): void {
  current = { ...current, ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // not persisted — still applies for this session
  }
  for (const l of listeners) l();
}

/** useSyncExternalStore-compatible subscribe. */
export function subscribeDevGfx(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
