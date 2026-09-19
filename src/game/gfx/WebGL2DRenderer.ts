import { createProgram, createUnitQuad, bindAttrib } from "./glutil";

const VERT_QUAD_2D = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform mat4 u_matrix;
uniform vec2 u_resolution;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = u_matrix * vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAG_TEXTURE = `#version 300 es
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
  private progTexture: WebGLProgram;
  private progSolid: WebGLProgram;
  private quadBuf: WebGLBuffer;
  private width: number;
  private height: number;
  private stack: { matrix: Float32Array }[] = [];
  private matrix: Float32Array = new Float32Array(16);
  private textureCache = new Map<string, WebGLTexture>();

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true });
    if (!gl) throw new Error("WebGL2 failed");

    this.gl = gl;
    this.width = canvas.width;
    this.height = canvas.height;
    this.quadBuf = createUnitQuad(gl);

    this.progTexture = createProgram("tex", VERT_QUAD_2D, FRAG_TEXTURE) || this.progSolid;
    this.progSolid = createProgram("solid", VERT_QUAD_2D, FRAG_SOLID) || this.progSolid;

    this.setIdentity();
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  private setIdentity() {
    this.matrix.set([
      2 / this.width, 0, 0, 0,
      0, -2 / this.height, 0, 0,
      0, 0, 1, 0,
      -1, 1, 0, 1
    ]);
  }

  clear() {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  save() {
    this.stack.push({ matrix: new Float32Array(this.matrix) });
  }

  restore() {
    const state = this.stack.pop();
    if (state) this.matrix.set(state.matrix);
  }

  translate(x: number, y: number) {
    const m = this.matrix;
    m[12] += x * m[0] + y * m[4];
    m[13] += x * m[1] + y * m[5];
  }

  rotate(angle: number) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const m = this.matrix;
    const m0 = m[0], m1 = m[1], m4 = m[4], m5 = m[5];
    m[0] = m0 * c + m4 * s;
    m[1] = m1 * c + m5 * s;
    m[4] = m4 * c - m0 * s;
    m[5] = m5 * c - m1 * s;
  }

  scale(sx: number, sy: number) {
    this.matrix[0] *= sx;
    this.matrix[1] *= sx;
    this.matrix[4] *= sy;
    this.matrix[5] *= sy;
  }

  drawImage(img: HTMLImageElement, x: number, y: number, w: number, h: number) {
    const gl = this.gl;
    gl.useProgram(this.progTexture);

    const tex = this.getTexture(img);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(this.progTexture, "u_tex"), 0);

    this.drawQuad(x, y, w, h);
  }

  fillRect(x: number, y: number, w: number, h: number, color: string = "#000000") {
    const gl = this.gl;
    gl.useProgram(this.progSolid);

    const rgb = this.parseColor(color);
    gl.uniform4f(gl.getUniformLocation(this.progSolid, "u_color"), rgb[0], rgb[1], rgb[2], 1.0);

    this.drawQuad(x, y, w, h);
  }

  fillText(text: string, x: number, y: number, color: string = "#000000", font: string = "12px Arial") {
    // Render text to offscreen canvas, then drawImage it
    const canvas = document.createElement("canvas");
    canvas.width = 256;
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

    const uMatrix = gl.getUniformLocation(
      gl.getParameter(gl.CURRENT_PROGRAM),
      "u_matrix"
    );

    const m = new Float32Array(16);
    m.set(this.matrix);
    m[0] *= w;
    m[4] *= h;
    m[12] += x;
    m[13] += y;

    gl.uniformMatrix4fv(uMatrix, false, m);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private getTexture(img: HTMLImageElement): WebGLTexture {
    const key = img.src;
    let tex = this.textureCache.get(key);
    if (!tex) {
      tex = this.gl.createTexture();
      if (!tex) throw new Error("Texture creation failed");
      this.gl.bindTexture(this.gl.TEXTURE_2D, tex);
      this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, img);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.textureCache.set(key, tex);
    }
    return tex;
  }

  private parseColor(color: string): [number, number, number] {
    const hex = color.replace("#", "");
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    return [r, g, b];
  }

  setSize(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.setIdentity();
  }
}
