import { createProgram, createUnitQuad, bindAttrib } from "./glutil";

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform mat4 u_matrix;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_TEX = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 FragColor;
void main() {
  FragColor = texture(u_tex, v_uv);
}
`;

const FRAG_SOLID = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 FragColor;
void main() {
  FragColor = u_color;
}
`;

export class WebGL2DRenderer {
  private gl: WebGL2RenderingContext;
  private progTex: WebGLProgram;
  private progSolid: WebGLProgram;
  private quadBuf: WebGLBuffer;
  private width: number;
  private height: number;
  private matrix: Float32Array = new Float32Array(16);
  private stack: Float32Array[] = [];
  private stateStack: Array<{ matrix: Float32Array; fillStyle: string; globalAlpha: number }> = [];
  private textureCache = new Map<CanvasImageSource, WebGLTexture>();
  fillStyle = "#000000";
  globalAlpha = 1.0;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
    if (!gl) throw new Error("WebGL2 context failed");

    this.gl = gl;
    this.width = canvas.width;
    this.height = canvas.height;
    this.quadBuf = createUnitQuad(gl);
    this.progTex = createProgram(gl, VERT, FRAG_TEX);
    this.progSolid = createProgram(gl, VERT, FRAG_SOLID);

    this.ortho(0, this.width, this.height, 0);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private ortho(left: number, right: number, bottom: number, top: number) {
    const m = this.matrix;
    m[0] = 2 / (right - left);
    m[5] = 2 / (top - bottom);
    m[10] = -1;
    m[15] = 1;
    m[12] = -(right + left) / (right - left);
    m[13] = -(top + bottom) / (top - bottom);
  }

  clear() {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  save() {
    this.stateStack.push({
      matrix: new Float32Array(this.matrix),
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
    });
  }

  restore() {
    const state = this.stateStack.pop();
    if (state) {
      this.matrix.set(state.matrix);
      this.fillStyle = state.fillStyle;
      this.globalAlpha = state.globalAlpha;
    }
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.matrix = new Float32Array(16);
    this.ortho(0, this.width, this.height, 0);
    const m = this.matrix;
    m[0] = a;
    m[1] = b;
    m[4] = c;
    m[5] = d;
    m[12] = e;
    m[13] = f;
  }

  translate(x: number, y: number) {
    const m = this.matrix;
    m[12] += x;
    m[13] += y;
  }

  scale(sx: number, sy: number) {
    const m = this.matrix;
    m[0] *= sx;
    m[1] *= sx;
    m[4] *= sy;
    m[5] *= sy;
  }

  rotate(angle: number) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const m = this.matrix;
    const m0 = m[0], m1 = m[1], m4 = m[4], m5 = m[5];
    m[0] = m0 * c + m4 * s;
    m[1] = m1 * c + m5 * s;
    m[4] = m0 * -s + m4 * c;
    m[5] = m1 * -s + m5 * c;
  }

  drawImage(img: CanvasImageSource, x: number, y: number, w: number, h: number) {
    const gl = this.gl;
    gl.useProgram(this.progTex);

    const tex = this.getTexture(img);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(this.progTex, "u_tex"), 0);

    this.drawQuad(x, y, w, h);
  }

  fillRect(x: number, y: number, w: number, h: number, color?: string) {
    const gl = this.gl;
    gl.useProgram(this.progSolid);

    const fillColor = color ?? this.fillStyle;
    const [r, g, b] = this.parseColor(fillColor);
    gl.uniform4f(gl.getUniformLocation(this.progSolid, "u_color"), r, g, b, this.globalAlpha);

    this.drawQuad(x, y, w, h);
  }

  fillText(text: string, x: number, y: number, color = "#000000", font = "12px Arial") {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = "top";
    ctx.fillText(text, 0, 0);

    this.drawImage(canvas, x, y, canvas.width, canvas.height);
  }

  private drawQuad(x: number, y: number, w: number, h: number) {
    const gl = this.gl;
    bindAttrib(gl, this.quadBuf, 0, 2);

    const m = new Float32Array(this.matrix);
    m[0] *= w;
    m[4] *= h;
    m[12] += x;
    m[13] += y;

    const prog = gl.getParameter(gl.CURRENT_PROGRAM);
    gl.uniformMatrix4fv(gl.getUniformLocation(prog, "u_matrix"), false, m);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private getTexture(img: CanvasImageSource): WebGLTexture {
    let tex = this.textureCache.get(img);
    if (!tex) {
      const gl = this.gl;
      tex = gl.createTexture();
      if (!tex) throw new Error("Texture creation failed");
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textureCache.set(img, tex);
    }
    return tex;
  }

  private parseColor(hex: string): [number, number, number] {
    const h = hex.replace("#", "");
    return [
      parseInt(h.substring(0, 2), 16) / 255,
      parseInt(h.substring(2, 4), 16) / 255,
      parseInt(h.substring(4, 6), 16) / 255
    ];
  }

  setSize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.gl.viewport(0, 0, w, h);
    this.ortho(0, w, h, 0);
  }

  clearRect(x: number, y: number, w: number, h: number) {
    this.fillRect(x, y, w, h, "rgba(0,0,0,0)");
  }

  fill() {
    // No-op for now; hexPath clipping is not supported in WebGL backend
  }

  stroke() {
    // No-op for now; path stroking is not supported in WebGL backend
  }

  clip() {
    // No-op for now; clipping paths are not supported in WebGL backend
  }
}
