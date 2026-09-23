/** GLSL sources for the global atmospheric + environmental lighting system (see
 * AtmosphereRenderer.ts / atmosphereParams.ts). Deliberately its own module, not touching
 * shaders.ts's elemental/spell FX sources — it reuses a couple of that module's generic,
 * non-spell-specific passes (the fullscreen triangle, the particle mote, the bright-pass/blur
 * pair) read-only, the same way glutil.ts and noiseTexture.ts are already shared plumbing.
 *
 * Two families of passes live here, matching the two canvases AtmosphereRenderer draws onto:
 *
 *  - GROUND passes (world-light multiply, ground haze, light shafts) draw directly onto the
 *    battle's own ground WebGL2 canvas, right after the terrain itself, so they're real pixels
 *    the elemental-FX layer then photographs as its "scene" texture — not a translucent sheet
 *    floating disconnected above everything. This is what makes lighting/haze read as PART of
 *    the terrain instead of a filter over a screenshot of it.
 *  - SKY passes (sky wash, bloom, final grade) draw onto a separate canvas stacked ABOVE the
 *    units layer, for the atmosphere units stand "inside" rather than underneath, and the one
 *    place sparse foreground motes are allowed to cross in front of a unit.
 *
 * Every world-space pass takes u_panOffset (screen minus world, CSS px — see
 * BattleEngine.effectAnchor) so noise fields hold still under camera panning; only their own
 * u_time-driven drift moves them, the same convention the water/river shader already uses. */

import { VERT_FULLSCREEN } from "./shaders";

const VERSION = "#version 300 es\n";
const PRECISION = "precision highp float;\n";

export { VERT_FULLSCREEN };

const FBM = `
float fbm(sampler2D noiseTex, vec2 uv) {
  return texture(noiseTex, uv).r * 0.55
       + texture(noiseTex, uv * 2.3 + 3.1).g * 0.3
       + texture(noiseTex, uv * 4.7 + 9.4).b * 0.15;
}
`;

/** Multiply-blended onto the ground canvas (gl.blendFunc(DST_COLOR, ZERO)) — real environmental
 * lighting, not a tint layer: ambient fill plus a soft directional wash toward u_lightDir, so
 * the battlefield reads as lit from a consistent direction rather than flat everywhere. Screen-
 * space on purpose — real sunlight doesn't vary across one battlefield's worth of world space. */
export const FRAG_WORLD_LIGHT_MULTIPLY = `${VERSION}${PRECISION}
in vec2 v_uv;
out vec4 fragColor;
uniform vec2 u_lightDir;
uniform vec3 u_lightColor;
uniform float u_lightIntensity;
uniform vec3 u_ambientColor;
uniform float u_ambientIntensity;

void main() {
  vec2 centered = v_uv * 2.0 - 1.0;
  centered.y = -centered.y;
  float facing = clamp(0.5 + 0.5 * dot(normalize(centered + 1e-4), u_lightDir), 0.0, 1.0);
  vec3 color = u_ambientColor * u_ambientIntensity + u_lightColor * u_lightIntensity * mix(0.45, 1.0, facing);
  fragColor = vec4(color, 1.0);
}
`;

/** Ground-hugging haze/mist — alpha-blended world-space noise, tinted toward the current
 * WorldLight color (passed pre-mixed as u_hazeColor from JS, see AtmosphereRenderer) so lit
 * haze and shadowed haze don't read as one flat fog color. */
export const FRAG_GROUND_HAZE = `${VERSION}${PRECISION}
in vec2 v_uv;
out vec4 fragColor;
uniform vec2 u_resolution;
uniform vec2 u_panOffset;
uniform float u_time;
uniform sampler2D u_noiseTex;
uniform float u_density;
uniform float u_scale;
uniform float u_speed;
uniform vec3 u_color;
${FBM}
void main() {
  if (u_density <= 0.0001) { fragColor = vec4(0.0); return; }
  vec2 worldPx = v_uv * u_resolution - u_panOffset;
  vec2 uv = worldPx / 420.0 * u_scale + vec2(0.21, -0.09) * u_time * u_speed;
  float n = clamp(fbm(u_noiseTex, uv), 0.0, 1.0);
  float alpha = n * u_density;
  fragColor = vec4(u_color * alpha, alpha);
}
`;

/** Soft volumetric shafts raking across the field along the WorldLight's own direction —
 * additive, only ever visible where haze is already present to scatter through. Low elevation
 * (dawn/dusk) reads bigger and softer; a high overhead sun barely shows any. */
export const FRAG_LIGHT_SHAFTS = `${VERSION}${PRECISION}
in vec2 v_uv;
out vec4 fragColor;
uniform vec2 u_resolution;
uniform vec2 u_panOffset;
uniform float u_time;
uniform sampler2D u_noiseTex;
uniform vec2 u_lightDir;
uniform float u_elevation;
uniform float u_intensity;
uniform float u_speed;
uniform float u_hazeDensity;
uniform vec3 u_color;
${FBM}
void main() {
  if (u_intensity <= 0.0001 || u_hazeDensity <= 0.0001) { fragColor = vec4(0.0); return; }
  vec2 worldPx = v_uv * u_resolution - u_panOffset;
  float scale = mix(320.0, 620.0, u_elevation);
  float along = dot(worldPx, u_lightDir) / scale + u_time * u_speed;
  float across = dot(worldPx, vec2(-u_lightDir.y, u_lightDir.x)) / (scale * 2.4);
  float shaft = pow(max(0.0, sin(along * 1.6)), 4.0) * pow(max(0.0, sin(across * 0.6 + along * 0.2)), 2.0);
  float soft = fbm(u_noiseTex, worldPx / 900.0 + u_time * u_speed * 0.4);
  float amount = shaft * mix(0.5, 1.0, soft) * u_intensity * mix(1.3, 0.5, u_elevation) * u_hazeDensity;
  fragColor = vec4(u_color * amount, amount);
}
`;

/** Broad, softer world-space wash on the SKY canvas — larger scale, slower, alpha capped low
 * so units stand out through it instead of being obscured. This is the "characters exist inside
 * the atmosphere, not under a filter" layer: it drifts with the world (panOffset) but sits above
 * units, at low enough opacity that it reads as ambient depth rather than fog blocking the view. */
export const FRAG_SKY_WASH = `${VERSION}${PRECISION}
in vec2 v_uv;
out vec4 fragColor;
uniform vec2 u_resolution;
uniform vec2 u_panOffset;
uniform float u_time;
uniform sampler2D u_noiseTex;
uniform float u_density;
uniform float u_scale;
uniform float u_speed;
uniform vec3 u_color;
uniform vec2 u_lightDir;
uniform float u_lightIntensity;
${FBM}
void main() {
  if (u_density <= 0.0001) { fragColor = vec4(0.0); return; }
  // Parallax: sampled at a fraction of the true pan offset so this layer drifts slightly
  // slower than the ground/terrain under camera pan — the standard cue that it sits further
  // back in depth, not glued to the same plane as the terrain.
  vec2 worldPx = v_uv * u_resolution - u_panOffset * 0.6;
  vec2 uv = worldPx / 900.0 * u_scale - vec2(0.13, 0.07) * u_time * u_speed;
  float n = clamp(fbm(u_noiseTex, uv), 0.0, 1.0);
  vec2 centered = v_uv * 2.0 - 1.0;
  centered.y = -centered.y;
  float glow = pow(clamp(0.5 + 0.5 * dot(normalize(centered + 1e-4), u_lightDir), 0.0, 1.0), 3.0) * u_lightIntensity;
  float alpha = clamp(n * u_density * 0.6 + glow * 0.12, 0.0, 0.35);
  vec3 color = u_color * (n * 0.5 + 0.5) + vec3(1.0, 0.95, 0.85) * glow * 0.2;
  fragColor = vec4(color * alpha, alpha);
}
`;

/** Adds the sky layer's own blurred bloom back on top, then final grading: contrast/saturation/
 * a slight tonal pull toward the current WorldLight color (u_tonalColor, fixed weight — the
 * "environmental color integration" from the design brief), and a screen-space vignette. This
 * canvas sits above the entire viewport, so this is as close as a two-canvas pipeline gets to a
 * true whole-frame grade without reading back the terrain/units canvases as textures. */
export const FRAG_SKY_COMPOSITE = `${VERSION}${PRECISION}
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_main;
uniform sampler2D u_bloom;
uniform float u_bloomStrength;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_vignette;
uniform vec3 u_tonalColor;

void main() {
  vec4 base = texture(u_main, v_uv);
  vec3 bloom = texture(u_bloom, v_uv).rgb;
  vec3 color = base.rgb + bloom * u_bloomStrength;
  float bloomLuma = max(bloom.r, max(bloom.g, bloom.b));
  float alpha = clamp(base.a + bloomLuma * u_bloomStrength * 0.6, 0.0, 1.0);

  color = (color - 0.5) * u_contrast + 0.5;
  float luma = dot(color, vec3(0.299, 0.587, 0.114));
  color = mix(vec3(luma), color, u_saturation);
  color = mix(color, color * u_tonalColor, 0.06);

  vec2 centered = v_uv - 0.5;
  float vig = u_vignette * clamp(dot(centered, centered) * 2.2, 0.0, 1.0);
  // The vignette must darken the WHOLE frame (units included) even where the procedural haze/
  // glow above contributed nothing — composited as a plain black layer UNDER the haze/glow
  // ("A over B" with A = black at alpha vig, B = this pass's own color at its own alpha), so a
  // vignette-only pixel still gets an honest alpha instead of relying on haze coverage.
  vec3 outRgb = color * alpha * (1.0 - vig);
  float outAlpha = vig + alpha * (1.0 - vig);
  fragColor = vec4(outRgb, outAlpha);
}
`;
