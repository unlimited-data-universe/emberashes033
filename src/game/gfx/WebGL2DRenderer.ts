/** A from-scratch WebGL2 stand-in for CanvasRenderingContext2D, built to cover exactly the
 * subset of the Canvas2D API that engine.ts's renderGround/renderUnitsAndOverlays actually
 * call (audited directly against that file, not the full spec):
 *
 *  - path building: beginPath/moveTo/lineTo/closePath/arc/quadraticCurveTo/rect
 *  - fill()/stroke(), including the one Path2D-argument case (blade-sweep crescent)
 *  - one clip() use (per-hex tile-art masking) via a stencil mask, scoped to save()/restore()
 *  - createLinearGradient/createRadialGradient + addColorStop (always same-center circles
 *    for the radial case — every call site in engine.ts uses that form)
 *  - globalCompositeOperation, but only ever "source-over" or "lighter" in this codebase
 *  - shadowColor/shadowBlur (approximated as a soft multi-ring glow — cheap, no offscreen
 *    blur pass, and this codebase never sets shadowOffsetX/Y so every shadow here really is
 *    a centered glow, not an offset drop-shadow)
 *  - filter, but only ever "none" or "brightness(x)" here
 *  - fillText honoring ctx.font/fillStyle/textAlign/textBaseline (cached as textures, keyed
 *    by their own content, instead of re-rasterizing every frame)
 *  - drawImage(img, x, y, w, h) — the only signature used here (no source-rect slicing)
 *
 * Deliberately NOT a general Canvas2D polyfill: lineCap/lineJoin are always "round" in this
 * codebase so stroke() always renders round joins/caps, strokeStyle is always a flat color
 * (never a gradient) here, and gradients/clip never nest beyond what's audited above.
 */
import { createProgram, bindAttrib } from "./glutil";

const VERT_LOCAL = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform mat4 u_matrix;
out vec2 v_local;
void main() {
  v_local = a_pos;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}
`;

const VERT_UNIT_QUAD = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform mat4 u_matrix;
uniform vec4 u_rect; // x, y, w, h in local space
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  vec2 local = u_rect.xy + v_uv * u_rect.zw;
  gl_Position = u_matrix * vec4(local, 0.0, 1.0);
}
`;

// Unified fill shader: solid color, or a linear/radial gradient sampled from a baked 1D LUT.
const FRAG_FILL = `#version 300 es
precision highp float;
in vec2 v_local;
uniform int u_mode; // 0 = solid, 1 = linear gradient, 2 = radial gradient
uniform vec4 u_color;
uniform sampler2D u_gradTex;
uniform vec4 u_gradP; // linear: p0.xy, p1.xy | radial: center.xy, r0, r1
uniform float u_alpha;
out vec4 FragColor;
void main() {
  vec4 c;
  if (u_mode == 0) {
    c = u_color;
  } else if (u_mode == 1) {
    vec2 axis = u_gradP.zw - u_gradP.xy;
    float len2 = max(dot(axis, axis), 1e-6);
    float t = dot(v_local - u_gradP.xy, axis) / len2;
    c = texture(u_gradTex, vec2(clamp(t, 0.0, 1.0), 0.5));
  } else {
    float d = distance(v_local, u_gradP.xy);
    float t = (d - u_gradP.z) / max(u_gradP.w - u_gradP.z, 1e-6);
    c = texture(u_gradTex, vec2(clamp(t, 0.0, 1.0), 0.5));
  }
  FragColor = vec4(c.rgb, c.a * u_alpha);
}
`;

const FRAG_TEX = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_alpha;
uniform float u_brightness;
uniform int u_tintMode; // 0 = normal texture color, 1 = flat tint using texture's alpha
uniform vec3 u_tint;
out vec4 FragColor;
void main() {
  vec4 t = texture(u_tex, v_uv);
  vec3 rgb = u_tintMode == 1 ? u_tint : t.rgb * u_brightness;
  FragColor = vec4(rgb, t.a * u_alpha);
}
`;

type Rgba = [number, number, number, number];

function sweepDelta(a0: number, a1: number, ccw: boolean): number {
  const TWO_PI = Math.PI * 2;
  let delta = a1 - a0;
  if (!ccw) {
    while (delta < 0) delta += TWO_PI;
    delta = Math.min(delta, TWO_PI);
  } else {
    while (delta > 0) delta -= TWO_PI;
    delta = Math.max(delta, -TWO_PI);
  }
  return delta;
}

function tessellateArc(cx: number, cy: number, r: number, a0: number, a1: number, ccw: boolean): number[] {
  const delta = sweepDelta(a0, a1, ccw);
  const segs = Math.max(6, Math.ceil((Math.abs(delta) * Math.max(r, 1)) / 6));
  const pts: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (delta * i) / segs;
    pts.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return pts;
}

function tessellateEllipse(
  cx: number, cy: number, rx: number, ry: number, rotation: number, a0: number, a1: number, ccw: boolean,
): number[] {
  const delta = sweepDelta(a0, a1, ccw);
  const segs = Math.max(6, Math.ceil((Math.abs(delta) * Math.max(rx, ry, 1)) / 6));
  const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
  const pts: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = a0 + (delta * i) / segs;
    const ex = rx * Math.cos(a), ey = ry * Math.sin(a);
    pts.push(cx + ex * cosR - ey * sinR, cy + ex * sinR + ey * cosR);
  }
  return pts;
}

function tessellateQuadratic(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number): number[] {
  const segs = 12;
  const pts: number[] = [];
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const mt = 1 - t;
    const x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
    const y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
    pts.push(x, y);
  }
  return pts;
}

interface SubPath {
  pts: number[]; // flat [x0,y0,x1,y1,...] in local space
  closed: boolean;
}

/** Shared by the renderer's own implicit path and the exported Path2D shim below — both just
 * record subpaths the same way. */
class PathRecorder {
  subpaths: SubPath[] = [];
  protected cur: SubPath | null = null;

  moveTo(x: number, y: number): void {
    this.cur = { pts: [x, y], closed: false };
    this.subpaths.push(this.cur);
  }
  lineTo(x: number, y: number): void {
    if (!this.cur) this.moveTo(x, y);
    else this.cur.pts.push(x, y);
  }
  closePath(): void {
    if (this.cur) this.cur.closed = true;
  }
  arc(x: number, y: number, r: number, startAngle: number, endAngle: number, ccw = false): void {
    const pts = tessellateArc(x, y, r, startAngle, endAngle, ccw);
    if (!this.cur) this.moveTo(pts[0], pts[1]);
    else this.cur.pts.push(pts[0], pts[1]);
    if (this.cur) this.cur.pts.push(...pts.slice(2));
  }
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, startAngle: number, endAngle: number, ccw = false): void {
    const pts = tessellateEllipse(x, y, rx, ry, rotation, startAngle, endAngle, ccw);
    if (!this.cur) this.moveTo(pts[0], pts[1]);
    else this.cur.pts.push(pts[0], pts[1]);
    if (this.cur) this.cur.pts.push(...pts.slice(2));
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (!this.cur) this.moveTo(cx, cy);
    const last = this.cur!;
    const x0 = last.pts[last.pts.length - 2];
    const y0 = last.pts[last.pts.length - 1];
    last.pts.push(...tessellateQuadratic(x0, y0, cx, cy, x, y));
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.cur = { pts: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true };
    this.subpaths.push(this.cur);
  }
}

/** Drop-in for the one `new Path2D()` use in engine.ts (the blade-sweep crescent) — importing
 * this class into that file shadows the DOM global of the same name, so the call site itself
 * needs no change. */
export class Path2D extends PathRecorder {}

class GLGradient {
  private tex: WebGLTexture | null = null;
  private dirty = true;
  private stops: Array<{ offset: number; rgba: Rgba }> = [];

  constructor(
    private kind: "linear" | "radial",
    private x0: number,
    private y0: number,
    private r0: number,
    private x1: number,
    private y1: number,
    private r1: number,
  ) {}

  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset, rgba: parseColorCached(color) });
    this.dirty = true;
  }

  /** [mode, gradX, gradY, gradZW...] uniform payload for FRAG_FILL. */
  uniformParams(): { mode: number; p: [number, number, number, number] } {
    if (this.kind === "linear") return { mode: 1, p: [this.x0, this.y0, this.x1, this.y1] };
    return { mode: 2, p: [this.x0, this.y0, this.r0, this.r1] };
  }

  getTexture(gl: WebGL2RenderingContext): WebGLTexture {
    if (!this.tex) {
      const tex = gl.createTexture();
      if (!tex) throw new Error("gradient texture creation failed");
      this.tex = tex;
    }
    if (this.dirty) {
      const N = 64;
      const data = new Uint8Array(N * 4);
      const sorted = [...this.stops].sort((a, b) => a.offset - b.offset);
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        let lo = sorted[0];
        let hi = sorted[sorted.length - 1];
        for (let s = 0; s < sorted.length - 1; s++) {
          if (t >= sorted[s].offset && t <= sorted[s + 1].offset) {
            lo = sorted[s];
            hi = sorted[s + 1];
            break;
          }
        }
        const span = hi.offset - lo.offset;
        const localT = span > 1e-6 ? (t - lo.offset) / span : 0;
        for (let c = 0; c < 4; c++) {
          const v = lo.rgba[c] + (hi.rgba[c] - lo.rgba[c]) * localT;
          data[i * 4 + c] = Math.round(c === 3 ? v * 255 : v * 255);
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.dirty = false;
    }
    return this.tex;
  }
}

type FillStyle = string | GLGradient;

const colorCache = new Map<string, Rgba>();
let colorProbeCtx: CanvasRenderingContext2D | null = null;

/** Parses any CSS color string (#hex, rgb()/rgba(), hsl(), named colors, ...) by letting the
 * browser do it via a 1x1 canvas, then caches the result — this codebase reuses the same
 * handful of color strings on every frame. */
function parseColorCached(style: string): Rgba {
  const hit = colorCache.get(style);
  if (hit) return hit;
  if (!colorProbeCtx) {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    colorProbeCtx = c.getContext("2d", { willReadFrequently: true });
  }
  let rgba: Rgba = [0, 0, 0, 1];
  if (colorProbeCtx) {
    colorProbeCtx.clearRect(0, 0, 1, 1);
    colorProbeCtx.fillStyle = style;
    colorProbeCtx.fillRect(0, 0, 1, 1);
    const d = colorProbeCtx.getImageData(0, 0, 1, 1).data;
    rgba = [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
  }
  colorCache.set(style, rgba);
  return rgba;
}

interface SavedState {
  matrix: Float32Array;
  fillStyle: FillStyle;
  strokeStyle: string;
  lineWidth: number;
  globalAlpha: number;
  globalCompositeOperation: string;
  shadowColor: string;
  shadowBlur: number;
  filter: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  clip: { subpaths: SubPath[]; matrix: Float32Array } | null;
}

interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

function pathBounds(subpaths: SubPath[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const sp of subpaths) {
    for (let i = 0; i < sp.pts.length; i += 2) {
      const x = sp.pts[i], y = sp.pts[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function scalePointsAboutCenter(subpaths: SubPath[], scale: number): SubPath[] {
  if (scale === 1) return subpaths;
  const b = pathBounds(subpaths);
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return subpaths.map((sp) => ({
    closed: sp.closed,
    pts: sp.pts.map((v, i) => (i % 2 === 0 ? cx + (v - cx) * scale : cy + (v - cy) * scale)),
  }));
}

export class WebGL2DRenderer {
  private gl: WebGL2RenderingContext;
  private progFill: WebGLProgram;
  private progTex: WebGLProgram;
  private polyBuf: WebGLBuffer;
  private quadBuf: WebGLBuffer;
  private width: number;
  private height: number;
  private matrix: Float32Array = new Float32Array(16);
  private stateStack: SavedState[] = [];
  private textureCache = new Map<CanvasImageSource, WebGLTexture>();
  private textTextureCache = new Map<string, { tex: WebGLTexture; w: number; h: number }>();
  private path = new PathRecorder();
  private activeClip: { subpaths: SubPath[]; matrix: Float32Array } | null = null;

  fillStyle: FillStyle = "#000000";
  strokeStyle = "#000000";
  lineWidth = 1;
  lineCap = "round";
  lineJoin = "round";
  globalAlpha = 1.0;
  globalCompositeOperation = "source-over";
  shadowColor = "rgba(0,0,0,0)";
  shadowBlur = 0;
  filter = "none";
  font = "12px sans-serif";
  textAlign = "left";
  textBaseline = "alphabetic";

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, stencil: true });
    if (!gl) throw new Error("WebGL2 context failed");

    this.gl = gl;
    this.width = canvas.width;
    this.height = canvas.height;
    this.quadBuf = this.createBuffer(new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));
    this.polyBuf = gl.createBuffer()!;
    this.progFill = createProgram(gl, VERT_LOCAL, FRAG_FILL);
    this.progTex = createProgram(gl, VERT_UNIT_QUAD, FRAG_TEX);

    this.ortho(0, this.width, this.height, 0);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private createBuffer(data: Float32Array): WebGLBuffer {
    const buf = this.gl.createBuffer();
    if (!buf) throw new Error("gl.createBuffer failed");
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buf);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, data, this.gl.STATIC_DRAW);
    return buf;
  }

  private ortho(left: number, right: number, bottom: number, top: number) {
    const m = this.matrix;
    m.fill(0);
    m[0] = 2 / (right - left);
    m[5] = 2 / (top - bottom);
    m[10] = -1;
    m[15] = 1;
    m[12] = -(right + left) / (right - left);
    m[13] = -(top + bottom) / (top - bottom);
  }

  clear() {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.STENCIL_BUFFER_BIT);
  }

  setSize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.gl.viewport(0, 0, w, h);
    this.ortho(0, w, h, 0);
  }

  // ---- state stack ----

  save() {
    this.stateStack.push({
      matrix: new Float32Array(this.matrix),
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      globalCompositeOperation: this.globalCompositeOperation,
      shadowColor: this.shadowColor,
      shadowBlur: this.shadowBlur,
      filter: this.filter,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      clip: this.activeClip,
    });
  }

  restore() {
    const s = this.stateStack.pop();
    if (!s) return;
    this.matrix.set(s.matrix);
    this.fillStyle = s.fillStyle;
    this.strokeStyle = s.strokeStyle;
    this.lineWidth = s.lineWidth;
    this.globalAlpha = s.globalAlpha;
    this.globalCompositeOperation = s.globalCompositeOperation;
    this.shadowColor = s.shadowColor;
    this.shadowBlur = s.shadowBlur;
    this.filter = s.filter;
    this.font = s.font;
    this.textAlign = s.textAlign;
    this.textBaseline = s.textBaseline;
    this.activeClip = s.clip;
  }

  // ---- transform ----

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.ortho(0, this.width, this.height, 0);
    const ortho = new Float32Array(this.matrix);
    const m = new Float32Array(16);
    m[0] = a; m[1] = b; m[4] = c; m[5] = d; m[10] = 1; m[12] = e; m[13] = f; m[15] = 1;
    this.matrix = multiplyMat4(ortho, m);
  }

  translate(x: number, y: number) {
    const t = identity();
    t[12] = x; t[13] = y;
    this.matrix = multiplyMat4(this.matrix, t);
  }

  scale(sx: number, sy: number) {
    const s = identity();
    s[0] = sx; s[5] = sy;
    this.matrix = multiplyMat4(this.matrix, s);
  }

  rotate(angle: number) {
    const c = Math.cos(angle), sn = Math.sin(angle);
    const r = identity();
    r[0] = c; r[1] = sn; r[4] = -sn; r[5] = c;
    this.matrix = multiplyMat4(this.matrix, r);
  }

  // ---- path building (delegates to the implicit path recorder) ----

  beginPath() { this.path = new PathRecorder(); }
  moveTo(x: number, y: number) { this.path.moveTo(x, y); }
  lineTo(x: number, y: number) { this.path.lineTo(x, y); }
  closePath() { this.path.closePath(); }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false) { this.path.arc(x, y, r, a0, a1, ccw); }
  ellipse(x: number, y: number, rx: number, ry: number, rotation: number, a0: number, a1: number, ccw = false) {
    this.path.ellipse(x, y, rx, ry, rotation, a0, a1, ccw);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) { this.path.quadraticCurveTo(cx, cy, x, y); }
  rect(x: number, y: number, w: number, h: number) { this.path.rect(x, y, w, h); }

  // ---- gradients ----

  createLinearGradient(x0: number, y0: number, x1: number, y1: number): GLGradient {
    return new GLGradient("linear", x0, y0, 0, x1, y1, 0);
  }
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): GLGradient {
    // Every call site in this codebase shares one center between the two circles; the
    // gradient shader only ever interpolates distance-from-(x0,y0) between r0 and r1.
    return new GLGradient("radial", x0, y0, r0, x1, y1, r1);
  }

  // ---- blend / color helpers ----

  private applyBlend() {
    const gl = this.gl;
    if (this.globalCompositeOperation === "lighter") gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private styleToFillUniforms(style: FillStyle): { mode: number; color: Rgba; gradTex: WebGLTexture | null; gradP: [number, number, number, number] } {
    if (typeof style === "string") {
      return { mode: 0, color: parseColorCached(style), gradTex: null, gradP: [0, 0, 0, 0] };
    }
    const { mode, p } = style.uniformParams();
    return { mode, color: [1, 1, 1, 1], gradTex: style.getTexture(this.gl), gradP: p };
  }

  // ---- low-level triangle drawing shared by fill/stroke/clip-mask ----

  private drawTriangleFill(verts: number[], style: FillStyle, alphaMul: number, tint: Rgba | null) {
    if (verts.length < 6) return;
    const gl = this.gl;
    this.applyBlend();
    gl.useProgram(this.progFill);
    bindAttrib(gl, this.polyBuf, 0, 2);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    const u = tint ? { mode: 0, color: [tint[0], tint[1], tint[2], tint[3]] as Rgba, gradTex: null, gradP: [0, 0, 0, 0] as [number, number, number, number] } : this.styleToFillUniforms(style);
    gl.uniform1i(gl.getUniformLocation(this.progFill, "u_mode"), u.mode);
    gl.uniform4f(gl.getUniformLocation(this.progFill, "u_color"), u.color[0], u.color[1], u.color[2], u.color[3]);
    gl.uniform4f(gl.getUniformLocation(this.progFill, "u_gradP"), u.gradP[0], u.gradP[1], u.gradP[2], u.gradP[3]);
    gl.uniform1f(gl.getUniformLocation(this.progFill, "u_alpha"), this.globalAlpha * alphaMul);
    if (u.gradTex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, u.gradTex);
      gl.uniform1i(gl.getUniformLocation(this.progFill, "u_gradTex"), 0);
    }
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progFill, "u_matrix"), false, this.matrix);
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 2);
  }

  /** Stencil-then-cover fill of a single simple polygon (fan-from-first-point + INVERT, an
   * even-odd fill that's exact for every shape this codebase draws — plain convex polygons,
   * full circles, and the one concave annular-sector Path2D crescent). Handles concave/
   * non-star shapes correctly, unlike a plain fan-triangulate-and-draw. */
  private fillPolygonStencil(sp: SubPath, style: FillStyle, alphaMul: number, tint: Rgba | null) {
    const pts = sp.pts;
    if (pts.length < 6) return;
    const gl = this.gl;
    this.applyBlend();
    gl.enable(gl.STENCIL_TEST);

    // Pass 1: fan-triangulate from the first point, inverting stencil bit 1 per overlap.
    const fan: number[] = [];
    const x0 = pts[0], y0 = pts[1];
    for (let i = 2; i + 2 < pts.length + 2; i += 2) {
      const x1 = pts[i % pts.length], y1 = pts[(i + 1) % pts.length];
      const x2 = pts[(i + 2) % pts.length], y2 = pts[(i + 3) % pts.length];
      fan.push(x0, y0, x1, y1, x2, y2);
    }
    // stencilMask restricts INVERT to bit 0 — without it INVERT flips the whole byte, which
    // would then never compare equal to the small ref values used below (a real bug found
    // by actually running a battle: every clipped drawImage silently drew nothing).
    gl.colorMask(false, false, false, false);
    gl.stencilMask(0x01);
    gl.stencilFunc(gl.ALWAYS, 1, 0x01);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    gl.useProgram(this.progFill);
    bindAttrib(gl, this.polyBuf, 0, 2);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fan), gl.DYNAMIC_DRAW);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progFill, "u_matrix"), false, this.matrix);
    gl.uniform1i(gl.getUniformLocation(this.progFill, "u_mode"), 0);
    gl.uniform4f(gl.getUniformLocation(this.progFill, "u_color"), 0, 0, 0, 0);
    gl.uniform1f(gl.getUniformLocation(this.progFill, "u_alpha"), 0);
    gl.drawArrays(gl.TRIANGLES, 0, fan.length / 2);

    // Pass 2: cover the bbox where bit 0 is set, with the real fill color/gradient. Masking
    // the test to bit 0 (rather than the full byte) means this still works correctly even
    // while a clip mask is occupying bit 1 (see apply/clearClipMask below).
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, 0x01, 0x01);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    const b = pathBounds([sp]);
    const pad = Math.max(b.w, b.h) * 0.02 + 1;
    const cover = [
      b.x - pad, b.y - pad,
      b.x + b.w + pad, b.y - pad,
      b.x - pad, b.y + b.h + pad,
      b.x - pad, b.y + b.h + pad,
      b.x + b.w + pad, b.y - pad,
      b.x + b.w + pad, b.y + b.h + pad,
    ];
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(cover), gl.DYNAMIC_DRAW);
    const u = tint ? { mode: 0, color: tint, gradTex: null as WebGLTexture | null, gradP: [0, 0, 0, 0] as [number, number, number, number] } : this.styleToFillUniforms(style);
    gl.uniform1i(gl.getUniformLocation(this.progFill, "u_mode"), u.mode);
    gl.uniform4f(gl.getUniformLocation(this.progFill, "u_color"), u.color[0], u.color[1], u.color[2], u.color[3]);
    gl.uniform4f(gl.getUniformLocation(this.progFill, "u_gradP"), u.gradP[0], u.gradP[1], u.gradP[2], u.gradP[3]);
    gl.uniform1f(gl.getUniformLocation(this.progFill, "u_alpha"), this.globalAlpha * alphaMul);
    if (u.gradTex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, u.gradTex);
      gl.uniform1i(gl.getUniformLocation(this.progFill, "u_gradTex"), 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Reset bit 0 back to 0 (ZERO, not INVERT — this must work regardless of exactly what
    // pass 1 left behind) so the next fill starts clean without disturbing an active clip's
    // bit 1.
    gl.colorMask(false, false, false, false);
    gl.stencilMask(0x01);
    gl.stencilFunc(gl.ALWAYS, 0, 0x01);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fan), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, fan.length / 2);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0xff);
    gl.disable(gl.STENCIL_TEST);
  }

  private withGlow(bounds: Bounds, draw: (scaleMul: number, tint: Rgba | null, alphaMul: number) => void) {
    if (this.shadowBlur > 0) {
      const [r, g, b, a] = parseColorCached(this.shadowColor);
      if (a > 0.004) {
        // Real Canvas2D shadowBlur is a soft Gaussian falloff; these are hard-edged scaled
        // copies standing in for it, so they're kept small and faint. Whole-alpha rings this
        // size read as a real blur on one isolated shape, but on the hex-range/target
        // highlights — many adjacent, mostly-opaque hexes, each contributing its own rings —
        // they used to stack (especially under "lighter" additive blending) into a much
        // brighter wash than the shape's own shadowColor alpha would ever produce natively.
        const ref = Math.max(bounds.w, bounds.h, 1);
        const rings: Array<[number, number]> = [
          [1 + (this.shadowBlur / ref) * 1.1, 0.05],
          [1 + (this.shadowBlur / ref) * 0.55, 0.1],
          [1 + (this.shadowBlur / ref) * 0.22, 0.16],
        ];
        for (const [scaleMul, weight] of rings) draw(scaleMul, [r, g, b, 1], a * weight);
      }
    }
    draw(1, null, 1);
  }

  /** Renders the active clip's mask into stencil bit 2 and enables the stencil test against
   * it, ahead of one masked draw call; call restoreAfterClipDraw() right after. Cheap and
   * correct for the single-hex-at-a-time usage this codebase actually has. */
  private applyClipMaskIfAny(): boolean {
    if (!this.activeClip) return false;
    const gl = this.gl;
    const sp = this.activeClip.subpaths[0];
    if (!sp) return false;
    const savedMatrix = new Float32Array(this.matrix);
    this.matrix = new Float32Array(this.activeClip.matrix);
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    // bit 1 (0x02) is this clip's own bit — restricted via stencilMask so INVERT (which
    // flips the whole byte if unmasked) can't stomp fillPolygonStencil's bit 0.
    gl.stencilMask(0x02);
    gl.stencilFunc(gl.ALWAYS, 2, 0x02);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    const fan: number[] = [];
    const pts = sp.pts;
    const x0 = pts[0], y0 = pts[1];
    for (let i = 2; i + 2 < pts.length + 2; i += 2) {
      const x1 = pts[i % pts.length], y1 = pts[(i + 1) % pts.length];
      const x2 = pts[(i + 2) % pts.length], y2 = pts[(i + 3) % pts.length];
      fan.push(x0, y0, x1, y1, x2, y2);
    }
    gl.useProgram(this.progFill);
    bindAttrib(gl, this.polyBuf, 0, 2);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fan), gl.DYNAMIC_DRAW);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progFill, "u_matrix"), false, this.matrix);
    gl.uniform1i(gl.getUniformLocation(this.progFill, "u_mode"), 0);
    gl.uniform4f(gl.getUniformLocation(this.progFill, "u_color"), 0, 0, 0, 0);
    gl.uniform1f(gl.getUniformLocation(this.progFill, "u_alpha"), 0);
    gl.drawArrays(gl.TRIANGLES, 0, fan.length / 2);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.EQUAL, 0x02, 0x02);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    this.matrix = savedMatrix;
    return true;
  }

  private clearClipMask() {
    const gl = this.gl;
    if (!this.activeClip) return;
    const sp = this.activeClip.subpaths[0];
    if (!sp) return;
    const savedMatrix = new Float32Array(this.matrix);
    this.matrix = new Float32Array(this.activeClip.matrix);
    gl.useProgram(this.progFill);
    gl.colorMask(false, false, false, false);
    gl.stencilMask(0x02);
    gl.stencilFunc(gl.ALWAYS, 0, 0x02);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    const fan: number[] = [];
    const pts = sp.pts;
    const x0 = pts[0], y0 = pts[1];
    for (let i = 2; i + 2 < pts.length + 2; i += 2) {
      const x1 = pts[i % pts.length], y1 = pts[(i + 1) % pts.length];
      const x2 = pts[(i + 2) % pts.length], y2 = pts[(i + 3) % pts.length];
      fan.push(x0, y0, x1, y1, x2, y2);
    }
    bindAttrib(this.gl, this.polyBuf, 0, 2);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(fan), gl.DYNAMIC_DRAW);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progFill, "u_matrix"), false, this.matrix);
    gl.drawArrays(gl.TRIANGLES, 0, fan.length / 2);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0xff);
    gl.disable(gl.STENCIL_TEST);
    this.matrix = savedMatrix;
  }

  // ---- public fill/stroke/clip ----

  fill(path?: PathRecorder) {
    const subpaths = (path ?? this.path).subpaths;
    if (subpaths.length === 0) return;
    const bounds = pathBounds(subpaths);
    const hadClip = this.applyClipMaskIfAny();
    this.withGlow(bounds, (scaleMul, tint, alphaMul) => {
      const scaled = scalePointsAboutCenter(subpaths, scaleMul);
      for (const sp of scaled) this.fillPolygonStencil(sp, this.fillStyle, alphaMul, tint);
    });
    if (hadClip) this.clearClipMask();
  }

  stroke(path?: PathRecorder) {
    const subpaths = (path ?? this.path).subpaths;
    if (subpaths.length === 0) return;
    const bounds = pathBounds(subpaths);
    const hw = this.lineWidth / 2;
    const build = (sps: SubPath[]): number[] => {
      const verts: number[] = [];
      for (const sp of sps) {
        const pts = sp.pts;
        const n = pts.length / 2;
        const segCount = sp.closed ? n : n - 1;
        for (let i = 0; i < segCount; i++) {
          const x0 = pts[(i * 2) % pts.length], y0 = pts[(i * 2 + 1) % pts.length];
          const x1 = pts[((i + 1) * 2) % pts.length], y1 = pts[((i + 1) * 2 + 1) % pts.length];
          const dx = x1 - x0, dy = y1 - y0;
          const len = Math.hypot(dx, dy) || 1;
          const nx = (-dy / len) * hw, ny = (dx / len) * hw;
          verts.push(x0 - nx, y0 - ny, x1 - nx, y1 - ny, x1 + nx, y1 + ny);
          verts.push(x0 - nx, y0 - ny, x1 + nx, y1 + ny, x0 + nx, y0 + ny);
        }
        // Round joins/caps at every vertex — this codebase always sets lineCap/lineJoin
        // to "round" wherever it sets them at all.
        const jointCount = sp.closed ? n : n;
        for (let i = 0; i < jointCount; i++) {
          const cx = pts[i * 2], cy = pts[i * 2 + 1];
          const segs = 10;
          for (let s = 0; s < segs; s++) {
            const a0 = (s / segs) * Math.PI * 2, a1 = ((s + 1) / segs) * Math.PI * 2;
            verts.push(cx, cy, cx + hw * Math.cos(a0), cy + hw * Math.sin(a0), cx + hw * Math.cos(a1), cy + hw * Math.sin(a1));
          }
        }
      }
      return verts;
    };
    const hadClip = this.applyClipMaskIfAny();
    this.withGlow(bounds, (scaleMul, tint, alphaMul) => {
      const scaled = scalePointsAboutCenter(subpaths, scaleMul);
      this.drawTriangleFill(build(scaled), this.strokeStyle, alphaMul, tint);
    });
    if (hadClip) this.clearClipMask();
  }

  clip() {
    this.activeClip = { subpaths: this.path.subpaths.map((sp) => ({ pts: [...sp.pts], closed: sp.closed })), matrix: new Float32Array(this.matrix) };
  }

  // ---- rects ----

  fillRect(x: number, y: number, w: number, h: number) {
    const hadClip = this.applyClipMaskIfAny();
    this.withGlow({ x, y, w, h }, (scaleMul, tint, alphaMul) => {
      const scaled = scalePointsAboutCenter([{ pts: [x, y, x + w, y, x + w, y + h, x, y + h], closed: true }], scaleMul);
      this.fillPolygonStencil(scaled[0], this.fillStyle, alphaMul, tint);
    });
    if (hadClip) this.clearClipMask();
  }

  /** Real Canvas2D clearRect erases to transparent regardless of blend mode — plain
   * alpha-blended drawing can't do that, so this draws with blending disabled instead of
   * routing through fillRect. */
  clearRect(x: number, y: number, w: number, h: number) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    this.drawTriangleFill([x, y, x + w, y, x + w, y + h, x, y, x + w, y + h, x, y + h], "#000000", 1, [0, 0, 0, 0]);
    gl.enable(gl.BLEND);
  }

  // ---- images ----

  private getTexture(img: CanvasImageSource): WebGLTexture {
    let tex = this.textureCache.get(img);
    if (!tex) {
      const gl = this.gl;
      tex = gl.createTexture();
      if (!tex) throw new Error("Texture creation failed");
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img as TexImageSource);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textureCache.set(img, tex);
    }
    return tex;
  }

  private parseBrightness(): number {
    const m = /brightness\(([\d.]+)\)/.exec(this.filter);
    return m ? parseFloat(m[1]) : 1;
  }

  private drawTexturedQuad(tex: WebGLTexture, x: number, y: number, w: number, h: number, alphaMul: number, tint: Rgba | null) {
    const gl = this.gl;
    this.applyBlend();
    gl.useProgram(this.progTex);
    bindAttrib(gl, this.quadBuf, 0, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(this.progTex, "u_tex"), 0);
    gl.uniform4f(gl.getUniformLocation(this.progTex, "u_rect"), x, y, w, h);
    gl.uniform1f(gl.getUniformLocation(this.progTex, "u_alpha"), this.globalAlpha * alphaMul);
    gl.uniform1f(gl.getUniformLocation(this.progTex, "u_brightness"), tint ? 1 : this.parseBrightness());
    gl.uniform1i(gl.getUniformLocation(this.progTex, "u_tintMode"), tint ? 1 : 0);
    if (tint) gl.uniform3f(gl.getUniformLocation(this.progTex, "u_tint"), tint[0], tint[1], tint[2]);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.progTex, "u_matrix"), false, this.matrix);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  drawImage(img: CanvasImageSource, x: number, y: number, w: number, h: number) {
    const tex = this.getTexture(img);
    const hadClip = this.applyClipMaskIfAny();
    this.withGlow({ x, y, w, h }, (scaleMul, tint, alphaMul) => {
      const cx = x + w / 2, cy = y + h / 2;
      const sw = w * scaleMul, sh = h * scaleMul;
      this.drawTexturedQuad(tex, cx - sw / 2, cy - sh / 2, sw, sh, alphaMul, tint);
    });
    if (hadClip) this.clearClipMask();
  }

  // ---- text ----

  /** The current transform's scale factor — always the devicePixelRatio in this codebase
   * (engine.ts opens every render with ctx.setTransform(dpr,0,0,dpr,0,0)), but derived from
   * the matrix rather than assumed. Needed to rasterize text at native resolution: text is
   * baked to a fixed-size offscreen canvas once and reused as a texture, so unlike vector
   * fills it doesn't get sharper for free when the transform scales it up — without this it
   * stayed CSS-pixel-resolution and came out visibly blurry on any HiDPI display. */
  private currentScale(): number {
    return Math.max(1, Math.hypot(this.matrix[0], this.matrix[1]));
  }

  private textKey(text: string, stroke: boolean, scale: number): string {
    const styleKey = stroke
      ? `stroke|${this.strokeStyle}|${this.lineWidth}`
      : `fill|${typeof this.fillStyle === "string" ? this.fillStyle : "grad"}`;
    return `${this.font}|${this.textAlign}|${this.textBaseline}|${styleKey}|${Math.round(scale * 4)}|${text}`;
  }

  private getTextTexture(text: string, stroke: boolean): { tex: WebGLTexture; w: number; h: number } {
    const scale = this.currentScale();
    const key = this.textKey(text, stroke, scale);
    const hit = this.textTextureCache.get(key);
    if (hit) return hit;
    const measureCanvas = document.createElement("canvas");
    const mctx = measureCanvas.getContext("2d")!;
    mctx.font = this.font;
    const metrics = mctx.measureText(text);
    const pad = stroke ? this.lineWidth + 4 : 4;
    const w = Math.max(1, Math.ceil(metrics.width) + pad * 2);
    const fontSizeMatch = /(\d+(?:\.\d+)?)px/.exec(this.font);
    const fontSize = fontSizeMatch ? parseFloat(fontSizeMatch[1]) : 16;
    const h = Math.max(1, Math.ceil(fontSize * 1.6 + pad));
    // Rasterize at scale× so the texture is native-resolution once the GPU draws this quad
    // back at `w × h` local units through the current (scale×) transform.
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.font = this.font;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    if (stroke) {
      ctx.lineJoin = "round";
      ctx.lineWidth = this.lineWidth;
      ctx.strokeStyle = this.strokeStyle;
      ctx.strokeText(text, pad, h * 0.12);
    } else {
      ctx.fillStyle = typeof this.fillStyle === "string" ? this.fillStyle : "#ffffff";
      ctx.fillText(text, pad, h * 0.12);
    }
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("text texture creation failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const entry = { tex, w, h };
    this.textTextureCache.set(key, entry);
    return entry;
  }

  private drawTextTexture(text: string, x: number, y: number, stroke: boolean) {
    if (!text) return;
    const { tex, w, h } = this.getTextTexture(text, stroke);
    let dx = x;
    if (this.textAlign === "center") dx = x - w / 2;
    else if (this.textAlign === "right") dx = x - w;
    let dy = y;
    if (this.textBaseline === "middle") dy = y - h / 2;
    else if (this.textBaseline === "bottom") dy = y - h * 0.85;
    else if (this.textBaseline === "top") dy = y - h * 0.1;
    else dy = y - h * 0.72; // alphabetic-ish default
    const hadClip = this.applyClipMaskIfAny();
    this.withGlow({ x: dx, y: dy, w, h }, (scaleMul, tint, alphaMul) => {
      const cx = dx + w / 2, cy = dy + h / 2;
      const sw = w * scaleMul, sh = h * scaleMul;
      this.drawTexturedQuad(tex, cx - sw / 2, cy - sh / 2, sw, sh, alphaMul, tint);
    });
    if (hadClip) this.clearClipMask();
  }

  fillText(text: string, x: number, y: number) {
    this.drawTextTexture(text, x, y, false);
  }

  strokeText(text: string, x: number, y: number) {
    this.drawTextTexture(text, x, y, true);
  }
}

function identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

function multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}
