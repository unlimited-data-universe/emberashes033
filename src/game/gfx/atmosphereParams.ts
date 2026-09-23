/** Tunable knobs + defaults for the global automatic atmospheric + environmental lighting
 * system (see AtmosphereRenderer.ts). Two things are modeled here, deliberately kept separate
 * per the design brief:
 *
 *  - WorldLight: the actual light source (Sun by day, Moon by night, flat ambient indoors/
 *    underground). Nothing about fog, haze or particles lives here — just direction, elevation,
 *    intensity and color. computeWorldLight derives it purely from environment + time of day.
 *  - AtmosphereProfile: fog/haze/particle/bloom/grading knobs. These REACT to WorldLight (haze
 *    tint, shaft direction) but never substitute for it — turning atmosphere off entirely still
 *    leaves the battlefield correctly lit.
 *
 * Every map gets a profile resolved from its `environment`/`timeOfDay`/`fogLevel` (see Mission
 * in types.ts) merged with ENVIRONMENT_DEFAULTS, plus an optional per-mission `atmosphere`
 * override for a handful of fields. BattleEngine resolves both once at construction (see
 * BattleEngine.atmosphereProfile/worldLight) and never touches EffectsRenderer's elemental-FX
 * state — this is its own pipeline end to end. */

export type Environment = "outdoor" | "indoor" | "underground" | "deepUnderground";
export type TimeOfDay = "dawn" | "day" | "dusk" | "night";
export type FogLevel = "off" | "low" | "medium" | "high";
export type ParticleKind = "dust" | "ash" | "mist" | "snow" | "spores";

export interface WorldLight {
  /** Screen-space unit vector (x right, y down) that POINTS TOWARD the light — same convention
   * as WebGL2DRenderer.setLightDirection, so the sprite relighting and the atmosphere agree on
   * where the sun lives. (0,0) means "no meaningful direction" (deep underground). */
  dirX: number;
  dirY: number;
  /** 0 (grazing the horizon) .. 1 (overhead). Low elevation = long, visible shafts and warm,
   * raking light; high elevation = short shafts and a more overhead wash. */
  elevation: number;
  /** Direct-light strength. 0 = no directional source at all — a torch-lit room isn't "lit by
   * the sun" even though ambientIntensity keeps it from going black. */
  intensity: number;
  color: [number, number, number];
  ambientColor: [number, number, number];
  /** Baseline fill light so nothing outside the direct beam ever crushes to pure black. */
  ambientIntensity: number;
}

export interface AtmosphereProfile {
  environment: Environment;
  timeOfDay: TimeOfDay;
  fogLevel: FogLevel;

  /** Base haze thickness before fogLevel's multiplier (see FOG_LEVEL_MULTIPLIER) is applied. */
  hazeDensity: number;
  /** World-space tiling of the haze noise. */
  hazeScale: number;
  /** How fast the haze drifts on its own, independent of camera movement. Kept small — real
   * motion should mostly come from panning through it, not the pattern crawling in place. */
  hazeSpeed: number;
  /** Neutral base tint; the renderer mixes this toward the current WorldLight color so lit
   * haze and shadowed haze read differently instead of being one flat fog color everywhere. */
  hazeColor: [number, number, number];

  /** Peak brightness of the volumetric light shafts. 0 effectively disables them (indoor/
   * underground defaults do this — see ENVIRONMENT_DEFAULTS). */
  volumetricIntensity: number;
  volumetricSpeed: number;

  particleKind: ParticleKind;
  particleColor: [number, number, number];
  /** Motes drawn UNDER units, baked onto the ground layer — hugging the terrain. */
  groundParticleCount: number;
  /** Motes drawn ABOVE units on the sky layer, surrounding them at low opacity. */
  skyParticleCount: number;
  /** Sparse, larger, closer-feeling motes on the same sky layer — the one thing allowed to
   * visually cross in front of a unit. Keep this small; it's a depth cue, not a screen-saver. */
  foregroundParticleCount: number;
  particleSpeed: number;
  particleSize: number;

  /** Luma above which the sky layer's own content starts contributing to its bloom pass. */
  bloomThreshold: number;
  bloomStrength: number;

  exposure: number;
  contrast: number;
  saturation: number;
  /** Darkening toward the screen edges, 0 = none. Deliberately screen-space, not world-space —
   * it's a property of the viewport, not the battlefield, and must hold still while panning. */
  vignette: number;
}

/** Fog is a player-facing global slider; it scales hazeDensity without needing a mission author
 * to hand-tune density directly. Applied at render time, never baked into the resolved profile,
 * so a mission's own hazeDensity override still means what it says. */
export const FOG_LEVEL_MULTIPLIER: Record<FogLevel, number> = {
  off: 0,
  low: 0.6,
  medium: 1.0,
  high: 1.7,
};

const OUTDOOR: AtmosphereProfile = {
  environment: "outdoor",
  timeOfDay: "day",
  fogLevel: "low",
  hazeDensity: 0.22,
  hazeScale: 1.4,
  hazeSpeed: 0.015,
  hazeColor: [0.82, 0.86, 0.95],
  volumetricIntensity: 0.22,
  volumetricSpeed: 0.03,
  particleKind: "dust",
  particleColor: [0.85, 0.82, 0.72],
  groundParticleCount: 26,
  skyParticleCount: 14,
  foregroundParticleCount: 4,
  particleSpeed: 10,
  particleSize: 1.8,
  bloomThreshold: 0.6,
  bloomStrength: 0.6,
  exposure: 1.0,
  contrast: 1.02,
  saturation: 1.02,
  vignette: 0.14,
};

const INDOOR: AtmosphereProfile = {
  environment: "indoor",
  timeOfDay: "day",
  fogLevel: "off",
  hazeDensity: 0.1,
  hazeScale: 1.8,
  hazeSpeed: 0.008,
  hazeColor: [0.85, 0.76, 0.62],
  volumetricIntensity: 0.16,
  volumetricSpeed: 0.02,
  particleKind: "dust",
  particleColor: [0.9, 0.82, 0.6],
  groundParticleCount: 14,
  skyParticleCount: 6,
  foregroundParticleCount: 2,
  particleSpeed: 6,
  particleSize: 1.4,
  bloomThreshold: 0.55,
  bloomStrength: 0.55,
  exposure: 1.0,
  contrast: 1.0,
  saturation: 1.0,
  vignette: 0.16,
};

const UNDERGROUND: AtmosphereProfile = {
  environment: "underground",
  timeOfDay: "day",
  fogLevel: "low",
  hazeDensity: 0.26,
  hazeScale: 1.9,
  hazeSpeed: 0.01,
  hazeColor: [0.55, 0.62, 0.68],
  volumetricIntensity: 0.04,
  volumetricSpeed: 0,
  particleKind: "mist",
  particleColor: [0.62, 0.68, 0.72],
  groundParticleCount: 20,
  skyParticleCount: 8,
  foregroundParticleCount: 2,
  particleSpeed: 5,
  particleSize: 2.2,
  bloomThreshold: 0.62,
  bloomStrength: 0.4,
  exposure: 0.95,
  contrast: 1.03,
  saturation: 0.9,
  vignette: 0.24,
};

const DEEP_UNDERGROUND: AtmosphereProfile = {
  environment: "deepUnderground",
  timeOfDay: "day",
  fogLevel: "medium",
  hazeDensity: 0.36,
  hazeScale: 2.1,
  hazeSpeed: 0.006,
  hazeColor: [0.3, 0.4, 0.36],
  volumetricIntensity: 0,
  volumetricSpeed: 0,
  particleKind: "spores",
  particleColor: [0.45, 0.85, 0.62],
  groundParticleCount: 16,
  skyParticleCount: 10,
  foregroundParticleCount: 3,
  particleSpeed: 4,
  particleSize: 2.0,
  bloomThreshold: 0.5,
  bloomStrength: 0.75,
  exposure: 0.9,
  contrast: 1.05,
  saturation: 0.85,
  vignette: 0.32,
};

export const ENVIRONMENT_DEFAULTS: Record<Environment, AtmosphereProfile> = {
  outdoor: OUTDOOR,
  indoor: INDOOR,
  underground: UNDERGROUND,
  deepUnderground: DEEP_UNDERGROUND,
};

/** Sun by day, Moon by night, flat torch/cave ambient indoors/underground — a small table
 * rather than a continuous curve. DEFAULT_ATMOSPHERE_PROFILE's own default (outdoor/day) has
 * to sit near WebGL2DRenderer's existing upper-left key light (dirX -0.6, dirY -0.8) so the
 * sun and the sprite rim-lighting/cast-shadow direction agree with each other. */
const WORLD_LIGHT_BY_TIME: Record<TimeOfDay, WorldLight> = {
  dawn: {
    dirX: -0.85,
    dirY: -0.45,
    elevation: 0.25,
    intensity: 0.55,
    color: [1.0, 0.68, 0.42],
    ambientColor: [0.45, 0.4, 0.55],
    ambientIntensity: 0.35,
  },
  day: {
    dirX: -0.6,
    dirY: -0.8,
    elevation: 0.8,
    intensity: 1.0,
    color: [1.0, 0.98, 0.92],
    ambientColor: [0.55, 0.62, 0.78],
    ambientIntensity: 0.55,
  },
  dusk: {
    dirX: 0.85,
    dirY: -0.4,
    elevation: 0.22,
    intensity: 0.5,
    color: [1.0, 0.5, 0.32],
    ambientColor: [0.4, 0.32, 0.5],
    ambientIntensity: 0.3,
  },
  night: {
    dirX: -0.4,
    dirY: -0.7,
    elevation: 0.55,
    intensity: 0.22,
    color: [0.55, 0.65, 0.95],
    ambientColor: [0.12, 0.14, 0.28],
    ambientIntensity: 0.22,
  },
};

const INDOOR_LIGHT: WorldLight = {
  dirX: 0,
  dirY: -1,
  elevation: 0.5,
  intensity: 0.15,
  color: [1.0, 0.82, 0.55],
  ambientColor: [0.5, 0.42, 0.32],
  ambientIntensity: 0.6,
};

const UNDERGROUND_LIGHT: WorldLight = {
  dirX: 0,
  dirY: 0,
  elevation: 0,
  intensity: 0.05,
  color: [0.6, 0.7, 0.9],
  ambientColor: [0.22, 0.24, 0.3],
  ambientIntensity: 0.4,
};

const DEEP_UNDERGROUND_LIGHT: WorldLight = {
  dirX: 0,
  dirY: 0,
  elevation: 0,
  intensity: 0.02,
  color: [0.5, 0.75, 0.65],
  ambientColor: [0.08, 0.09, 0.12],
  ambientIntensity: 0.22,
};

/** Sun/Moon are mathematical world lights, never placed objects — this is the entire authority
 * on "what lights this map right now." Indoor/underground ignore timeOfDay entirely (§0.5-style
 * closed list: there's no dawn indoors), matching the design brief's "Sun/Moon lighting can be
 * disabled and replaced by appropriate ambient environmental illumination." */
export function computeWorldLight(environment: Environment, timeOfDay: TimeOfDay): WorldLight {
  if (environment === "outdoor") return WORLD_LIGHT_BY_TIME[timeOfDay];
  if (environment === "indoor") return INDOOR_LIGHT;
  if (environment === "underground") return UNDERGROUND_LIGHT;
  return DEEP_UNDERGROUND_LIGHT;
}

/** One-stop resolve: environment default profile, with timeOfDay/fogLevel folded in and a
 * mission's own partial override layered on top last. hazeDensity stays whatever the result of
 * that merge is — FOG_LEVEL_MULTIPLIER is applied separately, at render time, so it scales
 * whichever density actually ends up in the profile rather than double-applying. */
export function resolveAtmosphereProfile(
  environment: Environment,
  timeOfDay: TimeOfDay,
  fogLevel: FogLevel | undefined,
  overrides: Partial<AtmosphereProfile> | undefined,
): AtmosphereProfile {
  const base = ENVIRONMENT_DEFAULTS[environment];
  return {
    ...base,
    environment,
    timeOfDay,
    fogLevel: fogLevel ?? base.fogLevel,
    ...(overrides ?? {}),
  };
}
