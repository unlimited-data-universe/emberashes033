/** Global automatic atmospheric + environmental lighting system. Two renderers, matching the
 * two depth planes this splits the battlefield into:
 *
 *  - GroundAtmosphere draws DIRECTLY onto the battle's own ground WebGL2 canvas (it shares that
 *    canvas's context — see the constructor — rather than owning a separate one), immediately
 *    after BattleEngine.renderGround finishes and before EffectsRenderer photographs the canvas
 *    as its "scene" texture. World lighting (a real multiply-blend pass, not a tint layer),
 *    ground haze and volumetric shafts become actual terrain pixels this way, so the elemental
 *    FX layer, and the eye, see one lit, hazy battlefield — not terrain art with a translucent
 *    weather sheet floating on top of it. Units draw on their own canvas ON TOP of this
 *    afterward, which is what puts them correctly in front of ground-hugging haze/dust for
 *    free, no explicit occlusion mask required.
 *  - SkyAtmosphere owns its own canvas, stacked above the units layer: a soft world-space wash
 *    (the atmosphere units stand "inside" rather than under), sparse foreground motes (the one
 *    thing allowed to cross in front of a unit), bloom and final grading. Both mote fields use
 *    a different fraction of the camera's pan delta (see MoteField's `parallax`) so the sky
 *    layer visibly reads as sitting further back than the ground layer while still tracking the
 *    map instead of the screen.
 *
 * Neither renderer touches EffectsRenderer's elemental-FX state, and both can be switched off
 * independently — atmosphereFxOn (haze/shafts/motes/bloom/sky-wash) and worldLightingOn (the
 * ground multiply pass alone) — see BattleEngine. Every uniform that positions something is in
 * CSS pixels, never device pixels; only FBO/canvas allocations and gl.viewport use device
 * pixels, exactly EffectsRenderer's convention. */

import { bindAttrib, createFbo, createFullscreenTri, createProgram, createUnitQuad, deleteFbo, resizeFbo, type Fbo } from "./glutil";
import { buildNoiseTexture } from "./noiseTexture";
import { FRAG_BLUR, FRAG_BRIGHTPASS, FRAG_PARTICLE, VERT_FULLSCREEN, VERT_QUAD } from "./shaders";
import { FRAG_GROUND_HAZE, FRAG_LIGHT_SHAFTS, FRAG_SKY_COMPOSITE, FRAG_SKY_WASH, FRAG_WORLD_LIGHT_MULTIPLY } from "./atmosphereShaders";
import { FOG_LEVEL_MULTIPLIER, type AtmosphereProfile, type ParticleKind, type WorldLight } from "./atmosphereParams";

const BLOOM_SCALE = 0.4;

function uniformLocations<T extends readonly string[]>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: T,
): Record<T[number], WebGLUniformLocation | null> {
  const out = {} as Record<T[number], WebGLUniformLocation | null>;
  for (const n of names) out[n as T[number]] = gl.getUniformLocation(program, n);
  return out;
}

function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  phase: number;
}

/** Kind-appropriate initial drift so dust/ash/mist/snow/spores each read as themselves instead
 * of five palette-swapped copies of the same particle. */
function spawnVelocity(kind: ParticleKind, speed: number): { vx: number; vy: number } {
  const angle = Math.random() * Math.PI * 2;
  switch (kind) {
    case "ash":
      return { vx: Math.cos(angle) * speed * 0.3, vy: -Math.abs(Math.sin(angle)) * speed - speed * 0.3 };
    case "snow":
      return { vx: Math.sin(angle) * speed * 0.4, vy: Math.abs(Math.cos(angle)) * speed * 0.5 + speed * 0.3 };
    case "mist":
      return { vx: Math.cos(angle) * speed * 0.5, vy: Math.sin(angle) * speed * 0.15 };
    case "spores":
      return { vx: Math.cos(angle) * speed * 0.6, vy: Math.sin(angle) * speed * 0.6 - speed * 0.15 };
    default:
      return { vx: Math.cos(angle) * speed * 0.4, vy: Math.sin(angle) * speed * 0.4 };
  }
}

/** A pool of screen-space motes that ride along with camera pans rather than sitting still on
 * screen while the map moves under them (see BattleCanvas's earlier dust-mote fix). `parallax`
 * scales how much of each frame's pan delta a field applies to itself: 1.0 glues it to the
 * terrain plane, <1 makes it drift as if further back (sky wash), >1 as if nearer (foreground
 * motes) — the standard depth cue, applied without any real depth buffer. */
class MoteField {
  motes: Mote[] = [];
  private lastPan: { x: number; y: number } | null = null;

  constructor(
    private kind: ParticleKind,
    private count: number,
    private speed: number,
    private size: number,
    private parallax: number,
  ) {}

  setConfig(count: number, speed: number, size: number, kind: ParticleKind): void {
    this.count = count;
    this.speed = speed;
    this.size = size;
    this.kind = kind;
  }

  private spawn(cssW: number, cssH: number, anywhere: boolean): Mote {
    const v = spawnVelocity(this.kind, this.speed);
    return {
      x: Math.random() * cssW,
      y: anywhere ? Math.random() * cssH : this.kind === "snow" ? -8 : cssH + 8,
      vx: v.vx,
      vy: v.vy,
      size: this.size * (0.6 + Math.random() * 0.8),
      phase: Math.random() * Math.PI * 2,
    };
  }

  update(dt: number, cssW: number, cssH: number, panX: number, panY: number): void {
    while (this.motes.length < this.count) this.motes.push(this.spawn(cssW, cssH, true));
    if (this.motes.length > this.count) this.motes.length = this.count;
    const panDeltaX = this.lastPan ? (panX - this.lastPan.x) * this.parallax : 0;
    const panDeltaY = this.lastPan ? (panY - this.lastPan.y) * this.parallax : 0;
    this.lastPan = { x: panX, y: panY };
    const margin = 24;
    for (const m of this.motes) {
      m.x += panDeltaX;
      m.y += panDeltaY;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.phase += dt;
      m.x += Math.sin(m.phase * 0.6) * 5 * dt;
      if (m.x < -margin) m.x = cssW + margin;
      if (m.x > cssW + margin) m.x = -margin;
      if (m.y < -margin || m.y > cssH + margin) {
        Object.assign(m, this.spawn(cssW, cssH, false));
      }
    }
  }
}

/** Draws a MoteField with the shared particle program — used identically by both renderers
 * below (each owns its own program/buffer on its own GL context, so this only factors out the
 * per-mote uniform/draw-call sequence, not any GL object). */
function drawMotes(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  uniforms: Record<"u_resolution" | "u_center" | "u_radius" | "u_rotation" | "u_worldCenter" | "u_color" | "u_alpha", WebGLUniformLocation | null>,
  quadBuf: WebGLBuffer,
  field: MoteField,
  cssW: number,
  cssH: number,
  color: [number, number, number],
  baseAlpha: number,
): void {
  gl.useProgram(program);
  bindAttrib(gl, quadBuf, 0, 2);
  gl.uniform2f(uniforms.u_resolution, cssW, cssH);
  gl.uniform3f(uniforms.u_color, color[0], color[1], color[2]);
  for (const m of field.motes) {
    gl.uniform2f(uniforms.u_center, m.x, m.y);
    gl.uniform2f(uniforms.u_radius, m.size, m.size);
    gl.uniform1f(uniforms.u_rotation, 0);
    gl.uniform2f(uniforms.u_worldCenter, m.x, m.y);
    gl.uniform1f(uniforms.u_alpha, (0.4 + 0.6 * (0.5 + 0.5 * Math.sin(m.phase))) * baseAlpha);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}

/** Ground/world depth plane — see the module comment. Shares its GL context with the ground
 * canvas's own WebGL2DRenderer (a second `getContext("webgl2", …)` call on an already-live
 * canvas returns the SAME context per spec, ignoring the attributes on that later call), so it
 * needs no canvas or resize bookkeeping of its own: every render() call reads the live
 * drawingBuffer size and the caller's own CSS dimensions fresh. */
export class GroundAtmosphere {
  private gl: WebGL2RenderingContext;
  private triBuf: WebGLBuffer;
  private quadBuf: WebGLBuffer;
  private noiseTex: WebGLTexture;

  private progLight: WebGLProgram;
  private uLight;
  private progHaze: WebGLProgram;
  private uHaze;
  private progShafts: WebGLProgram;
  private uShafts;
  private progParticle: WebGLProgram;
  private uParticle;

  private time = 0;
  private motes = new MoteField("dust", 0, 10, 2, 1.0);

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, stencil: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;

    this.triBuf = createFullscreenTri(gl);
    this.quadBuf = createUnitQuad(gl);
    this.noiseTex = buildNoiseTexture(gl, 256);

    this.progLight = createProgram(gl, VERT_FULLSCREEN, FRAG_WORLD_LIGHT_MULTIPLY);
    this.uLight = uniformLocations(gl, this.progLight, ["u_lightDir", "u_lightColor", "u_lightIntensity", "u_ambientColor", "u_ambientIntensity"] as const);

    this.progHaze = createProgram(gl, VERT_FULLSCREEN, FRAG_GROUND_HAZE);
    this.uHaze = uniformLocations(gl, this.progHaze, ["u_resolution", "u_panOffset", "u_time", "u_noiseTex", "u_density", "u_scale", "u_speed", "u_color"] as const);

    this.progShafts = createProgram(gl, VERT_FULLSCREEN, FRAG_LIGHT_SHAFTS);
    this.uShafts = uniformLocations(gl, this.progShafts, [
      "u_resolution",
      "u_panOffset",
      "u_time",
      "u_noiseTex",
      "u_lightDir",
      "u_elevation",
      "u_intensity",
      "u_speed",
      "u_hazeDensity",
      "u_color",
    ] as const);

    this.progParticle = createProgram(gl, VERT_QUAD, FRAG_PARTICLE);
    this.uParticle = uniformLocations(gl, this.progParticle, ["u_resolution", "u_center", "u_radius", "u_rotation", "u_worldCenter", "u_color", "u_alpha"] as const);
  }

  /** Call right after BattleEngine.renderGround, before EffectsRenderer reads the canvas — see
   * module comment. `fxEnabled` gates haze/shafts/motes; `lightingEnabled` gates ONLY the world-
   * light multiply pass, independently, per the design brief's debug requirement. */
  render(
    dt: number,
    cssW: number,
    cssH: number,
    panX: number,
    panY: number,
    profile: AtmosphereProfile,
    light: WorldLight,
    fxEnabled: boolean,
    lightingEnabled: boolean,
  ): void {
    const gl = this.gl;
    this.time += dt;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.BLEND);

    if (lightingEnabled) {
      gl.blendFunc(gl.DST_COLOR, gl.ZERO);
      gl.useProgram(this.progLight);
      bindAttrib(gl, this.triBuf, 0, 2);
      gl.uniform2f(this.uLight.u_lightDir, light.dirX, light.dirY);
      gl.uniform3f(this.uLight.u_lightColor, light.color[0], light.color[1], light.color[2]);
      gl.uniform1f(this.uLight.u_lightIntensity, light.intensity);
      gl.uniform3f(this.uLight.u_ambientColor, light.ambientColor[0], light.ambientColor[1], light.ambientColor[2]);
      gl.uniform1f(this.uLight.u_ambientIntensity, light.ambientIntensity);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    if (fxEnabled) {
      const density = profile.hazeDensity * FOG_LEVEL_MULTIPLIER[profile.fogLevel];
      const hazeColor = lerp3(profile.hazeColor, light.color, 0.3);

      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.progHaze);
      bindAttrib(gl, this.triBuf, 0, 2);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
      gl.uniform1i(this.uHaze.u_noiseTex, 0);
      gl.uniform2f(this.uHaze.u_resolution, cssW, cssH);
      gl.uniform2f(this.uHaze.u_panOffset, panX, panY);
      gl.uniform1f(this.uHaze.u_time, this.time);
      gl.uniform1f(this.uHaze.u_density, density);
      gl.uniform1f(this.uHaze.u_scale, profile.hazeScale);
      gl.uniform1f(this.uHaze.u_speed, profile.hazeSpeed);
      gl.uniform3f(this.uHaze.u_color, hazeColor[0], hazeColor[1], hazeColor[2]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const dirLen = Math.hypot(light.dirX, light.dirY);
      if (profile.volumetricIntensity > 0 && light.intensity > 0 && dirLen > 0.0001) {
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(this.progShafts);
        bindAttrib(gl, this.triBuf, 0, 2);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
        gl.uniform1i(this.uShafts.u_noiseTex, 0);
        gl.uniform2f(this.uShafts.u_resolution, cssW, cssH);
        gl.uniform2f(this.uShafts.u_panOffset, panX, panY);
        gl.uniform1f(this.uShafts.u_time, this.time);
        gl.uniform2f(this.uShafts.u_lightDir, light.dirX / dirLen, light.dirY / dirLen);
        gl.uniform1f(this.uShafts.u_elevation, light.elevation);
        gl.uniform1f(this.uShafts.u_intensity, profile.volumetricIntensity * light.intensity);
        gl.uniform1f(this.uShafts.u_speed, profile.volumetricSpeed);
        gl.uniform1f(this.uShafts.u_hazeDensity, density);
        gl.uniform3f(this.uShafts.u_color, light.color[0], light.color[1], light.color[2]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      this.motes.setConfig(profile.groundParticleCount, profile.particleSpeed, profile.particleSize, profile.particleKind);
      this.motes.update(dt, cssW, cssH, panX, panY);
      gl.blendFunc(gl.ONE, gl.ONE);
      drawMotes(gl, this.progParticle, this.uParticle, this.quadBuf, this.motes, cssW, cssH, profile.particleColor, 0.5);
    }

    // Leave blending in the state WebGL2DRenderer expects going into its next draw call.
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.noiseTex);
    gl.deleteBuffer(this.triBuf);
    gl.deleteBuffer(this.quadBuf);
    gl.deleteProgram(this.progLight);
    gl.deleteProgram(this.progHaze);
    gl.deleteProgram(this.progShafts);
    gl.deleteProgram(this.progParticle);
  }
}

/** Sky/foreground depth plane — see the module comment. Owns its own canvas/context, stacked
 * above the units layer, with its own reduced-resolution bloom chain (same technique as
 * EffectsRenderer's, a separate set of FBOs). */
export class SkyAtmosphere {
  private gl: WebGL2RenderingContext;
  private triBuf: WebGLBuffer;
  private quadBuf: WebGLBuffer;
  private noiseTex: WebGLTexture;

  private progWash: WebGLProgram;
  private uWash;
  private progParticle: WebGLProgram;
  private uParticle;
  private progBrightpass: WebGLProgram;
  private uBrightpass;
  private progBlur: WebGLProgram;
  private uBlur;
  private progComposite: WebGLProgram;
  private uComposite;

  private mainFbo: Fbo;
  private brightFbo: Fbo;
  private blurFboA: Fbo;
  private blurFboB: Fbo;

  private cssW = 1;
  private cssH = 1;
  private fullW = 1;
  private fullH = 1;
  private time = 0;

  // Sky/world-layer dust reads as sitting further back (parallax 0.6); foreground motes read as
  // nearer than the terrain (parallax 1.3) — see MoteField's comment.
  private skyMotes = new MoteField("dust", 0, 8, 2, 0.6);
  private fgMotes = new MoteField("dust", 0, 14, 3.4, 1.3);

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;

    this.triBuf = createFullscreenTri(gl);
    this.quadBuf = createUnitQuad(gl);
    this.noiseTex = buildNoiseTexture(gl, 256);

    this.progWash = createProgram(gl, VERT_FULLSCREEN, FRAG_SKY_WASH);
    this.uWash = uniformLocations(gl, this.progWash, [
      "u_resolution",
      "u_panOffset",
      "u_time",
      "u_noiseTex",
      "u_density",
      "u_scale",
      "u_speed",
      "u_color",
      "u_lightDir",
      "u_lightIntensity",
    ] as const);

    this.progParticle = createProgram(gl, VERT_QUAD, FRAG_PARTICLE);
    this.uParticle = uniformLocations(gl, this.progParticle, ["u_resolution", "u_center", "u_radius", "u_rotation", "u_worldCenter", "u_color", "u_alpha"] as const);

    this.progBrightpass = createProgram(gl, VERT_FULLSCREEN, FRAG_BRIGHTPASS);
    this.uBrightpass = uniformLocations(gl, this.progBrightpass, ["u_src", "u_threshold"] as const);

    this.progBlur = createProgram(gl, VERT_FULLSCREEN, FRAG_BLUR);
    this.uBlur = uniformLocations(gl, this.progBlur, ["u_src", "u_texel", "u_direction"] as const);

    this.progComposite = createProgram(gl, VERT_FULLSCREEN, FRAG_SKY_COMPOSITE);
    this.uComposite = uniformLocations(gl, this.progComposite, ["u_main", "u_bloom", "u_bloomStrength", "u_contrast", "u_saturation", "u_vignette", "u_tonalColor"] as const);

    this.mainFbo = createFbo(gl, 2, 2);
    this.brightFbo = createFbo(gl, 2, 2);
    this.blurFboA = createFbo(gl, 2, 2);
    this.blurFboB = createFbo(gl, 2, 2);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = Math.max(1, cssW);
    this.cssH = Math.max(1, cssH);
    const fullW = Math.max(1, Math.floor(this.cssW * dpr));
    const fullH = Math.max(1, Math.floor(this.cssH * dpr));
    if (this.canvas.width !== fullW) this.canvas.width = fullW;
    if (this.canvas.height !== fullH) this.canvas.height = fullH;
    this.fullW = fullW;
    this.fullH = fullH;
    const gl = this.gl;
    resizeFbo(gl, this.mainFbo, fullW, fullH);
    const bw = Math.max(1, Math.floor(fullW * BLOOM_SCALE));
    const bh = Math.max(1, Math.floor(fullH * BLOOM_SCALE));
    resizeFbo(gl, this.brightFbo, bw, bh);
    resizeFbo(gl, this.blurFboA, bw, bh);
    resizeFbo(gl, this.blurFboB, bw, bh);
  }

  render(dt: number, panX: number, panY: number, profile: AtmosphereProfile, light: WorldLight, fxEnabled: boolean): void {
    const gl = this.gl;
    if (!fxEnabled) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.fullW, this.fullH);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    this.time += dt;
    const density = profile.hazeDensity * FOG_LEVEL_MULTIPLIER[profile.fogLevel];

    // 1. Main pass: world-space sky wash, in world space so it drifts with the map (at reduced
    //    parallax — see the module comment), plus the sky/foreground mote fields.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mainFbo.fbo);
    gl.viewport(0, 0, this.mainFbo.w, this.mainFbo.h);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.progWash);
    bindAttrib(gl, this.triBuf, 0, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
    gl.uniform1i(this.uWash.u_noiseTex, 0);
    gl.uniform2f(this.uWash.u_resolution, this.cssW, this.cssH);
    gl.uniform2f(this.uWash.u_panOffset, panX, panY);
    gl.uniform1f(this.uWash.u_time, this.time);
    gl.uniform1f(this.uWash.u_density, density);
    gl.uniform1f(this.uWash.u_scale, profile.hazeScale);
    gl.uniform1f(this.uWash.u_speed, profile.hazeSpeed);
    gl.uniform3f(this.uWash.u_color, profile.hazeColor[0], profile.hazeColor[1], profile.hazeColor[2]);
    gl.uniform2f(this.uWash.u_lightDir, light.dirX, light.dirY);
    gl.uniform1f(this.uWash.u_lightIntensity, light.intensity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.skyMotes.setConfig(profile.skyParticleCount, profile.particleSpeed, profile.particleSize, profile.particleKind);
    this.fgMotes.setConfig(profile.foregroundParticleCount, profile.particleSpeed * 1.4, profile.particleSize, profile.particleKind);
    this.skyMotes.update(dt, this.cssW, this.cssH, panX, panY);
    this.fgMotes.update(dt, this.cssW, this.cssH, panX, panY);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    drawMotes(gl, this.progParticle, this.uParticle, this.quadBuf, this.skyMotes, this.cssW, this.cssH, profile.particleColor, 0.35);
    drawMotes(gl, this.progParticle, this.uParticle, this.quadBuf, this.fgMotes, this.cssW, this.cssH, profile.particleColor, 0.55);
    gl.disable(gl.BLEND);

    // 2. Bright-pass + separable blur, reduced resolution — identical technique to
    //    EffectsRenderer's bloom chain, a separate set of FBOs.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.brightFbo.fbo);
    gl.viewport(0, 0, this.brightFbo.w, this.brightFbo.h);
    gl.useProgram(this.progBrightpass);
    bindAttrib(gl, this.triBuf, 0, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mainFbo.tex);
    gl.uniform1i(this.uBrightpass.u_src, 0);
    gl.uniform1f(this.uBrightpass.u_threshold, profile.bloomThreshold);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(this.progBlur);
    bindAttrib(gl, this.triBuf, 0, 2);
    gl.uniform1i(this.uBlur.u_src, 0);
    const passes: [Fbo, Fbo][] = [
      [this.brightFbo, this.blurFboA],
      [this.blurFboA, this.blurFboB],
      [this.blurFboB, this.blurFboA],
    ];
    const dirs: [number, number][] = [
      [1, 0],
      [0, 1],
      [1, 0],
    ];
    for (let i = 0; i < passes.length; i++) {
      const [src, dst] = passes[i]!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(this.uBlur.u_texel, 1 / src.w, 1 / src.h);
      gl.uniform2f(this.uBlur.u_direction, dirs[i]![0], dirs[i]![1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    const bloomResult = this.blurFboA;

    // 3. Composite straight onto the visible canvas: bloom + final grading (see
    //    FRAG_SKY_COMPOSITE), alpha-blended over whatever BattleCanvas has already drawn.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.fullW, this.fullH);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progComposite);
    bindAttrib(gl, this.triBuf, 0, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mainFbo.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomResult.tex);
    gl.uniform1i(this.uComposite.u_main, 0);
    gl.uniform1i(this.uComposite.u_bloom, 1);
    gl.uniform1f(this.uComposite.u_bloomStrength, profile.bloomStrength);
    gl.uniform1f(this.uComposite.u_contrast, profile.contrast);
    gl.uniform1f(this.uComposite.u_saturation, profile.saturation);
    gl.uniform1f(this.uComposite.u_vignette, profile.vignette);
    gl.uniform3f(this.uComposite.u_tonalColor, light.color[0], light.color[1], light.color[2]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose(): void {
    const gl = this.gl;
    deleteFbo(gl, this.mainFbo);
    deleteFbo(gl, this.brightFbo);
    deleteFbo(gl, this.blurFboA);
    deleteFbo(gl, this.blurFboB);
    gl.deleteTexture(this.noiseTex);
    gl.deleteBuffer(this.triBuf);
    gl.deleteBuffer(this.quadBuf);
    gl.deleteProgram(this.progWash);
    gl.deleteProgram(this.progParticle);
    gl.deleteProgram(this.progBrightpass);
    gl.deleteProgram(this.progBlur);
    gl.deleteProgram(this.progComposite);
  }
}
