import * as THREE from "three";

/** HD-2D proof-of-concept: real 3D hex terrain + shadow-mapped directional light +
 * a camera-facing billboard sprite that receives that same light and casts/receives shadow.
 * This is the foundation slice for the Triangle-Strategy-style look — not the full battle
 * engine port, which is a separate, much larger task once this pipeline is proven. */

const HEX_SIZE = 1; // flat-top hex circumradius in world units

function hexPoints(size: number): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i);
    pts.push(new THREE.Vector2(size * Math.cos(angle), size * Math.sin(angle)));
  }
  return pts;
}

function mulberry32Local(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Scene3DHandle {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  setBillboardTexture: (tex: THREE.Texture) => void;
  showHexOutline: (col: number, row: number, color?: number) => THREE.Line;
  clearHexOutlines: () => void;
  /** Dev A/B toggle (Phase 1): soft PCF shadow filtering vs. the unfiltered hard-edge
   * baseline. Leaves light position, shadow-camera bounds, bias and map size untouched. */
  setPcfSoftShadows: (enabled: boolean) => void;
  /** Dev toggle (Phase 2): short-range contact shadow under the billboard. Independent of
   * the directional-light shadow, which stays on regardless of this flag. */
  setContactShadows: (enabled: boolean) => void;
  resize: (w: number, h: number) => void;
  dispose: () => void;
}

export function createScene3D(canvas: HTMLCanvasElement, cols: number, rows: number): Scene3DHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap is deprecated as of r186 (merged into this)
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1f2e);
  scene.fog = new THREE.Fog(0x1a1f2e, 20, 60);

  // Triangle Strategy reads as a tilted diorama: a narrow-ish FOV perspective camera looking
  // down at roughly 35-45 degrees, not a true orthographic top-down or a flat side view.
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  const boardW = cols * 1.5;
  const boardD = rows * 1.73;
  camera.position.set(boardW * 0.15, boardD * 0.85, boardD * 0.95);
  camera.lookAt(boardW * 0.15, 0, 0);

  // Key light: the one that actually casts the shadow-mapped shadows.
  const sun = new THREE.DirectionalLight(0xfff2e0, 2.2);
  sun.position.set(8, 14, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -20;
  sun.shadow.camera.right = 20;
  sun.shadow.camera.top = 20;
  sun.shadow.camera.bottom = -20;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 50;
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x8899bb, 0.55));
  const fill = new THREE.DirectionalLight(0x8ec6ff, 0.35);
  fill.position.set(-6, 6, -4);
  scene.add(fill);

  // Ground plane so tiles have something continuous to sit on and cast shadows onto.
  const groundGeo = new THREE.PlaneGeometry(200, 200);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x11151f, roughness: 1 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  // Hex terrain, done the way that actually hides the grid: ONE continuous mesh, densely
  // subdivided, with per-vertex height/color blended by inverse-distance weighting across the
  // 3 nearest hex centers. No tile ever has a hard edge — neighbours melt into each other like
  // real terrain, and the hex grid itself becomes invisible except where a gameplay overlay
  // (movement/attack range) explicitly draws it back in on top. Every earlier attempt that drew
  // one mesh/sprite per hex was always going to show seams, however good the per-tile art was —
  // that's a property of tiling discrete shapes, not a texture problem.
  const hexW = HEX_SIZE * 1.5;
  const hexH = HEX_SIZE * Math.sqrt(3);
  const centers: { x: number; z: number; height: number; color: THREE.Color }[] = [];
  const palette = [
    new THREE.Color(0x3a5f4a), // grass
    new THREE.Color(0x4a6b3f), // grass variant
    new THREE.Color(0x8a7a54), // dirt/path
    new THREE.Color(0x5c6b7a), // stone
  ];
  const rng = mulberry32Local(1234);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const wx = x * hexW;
      const wz = y * hexH + (x % 2 === 1 ? hexH / 2 : 0);
      const height = rng() < 0.12 ? 0.35 + rng() * 0.4 : 0; // occasional raised ground, blends in
      const color = palette[Math.floor(rng() * palette.length)]!.clone();
      centers.push({ x: wx, z: wz, height, color });
    }
  }

  // Same inverse-distance height blend as the vertex loop below, exposed standalone so
  // anything placed on the ground (contact-shadow decals, later props) can sit at the
  // real local surface height instead of assuming flat y=0 — the terrain is not flat.
  function terrainHeightAt(x: number, z: number): number {
    let wsum = 0;
    let hsum = 0;
    for (const c of centers) {
      const dx = x - c.x;
      const dz = z - c.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > hexW * hexW * 4) continue;
      const w = 1 / (d2 + 0.05);
      wsum += w;
      hsum += w * c.height;
    }
    return wsum > 0 ? hsum / wsum : 0;
  }

  const boardWspan = (cols + 1) * hexW;
  const boardDspan = (rows + 1) * hexH;
  const segs = Math.max(40, Math.floor((cols + rows) * 3));
  const groundBlend = new THREE.PlaneGeometry(boardWspan, boardDspan, segs, segs);
  groundBlend.rotateX(-Math.PI / 2);
  groundBlend.translate(boardWspan / 2 - hexW, 0, boardDspan / 2 - hexH);
  const pos = groundBlend.attributes.position as THREE.BufferAttribute;
  const colorArr = new Float32Array(pos.count * 3);
  const tmpColor = new THREE.Color();
  for (let vi = 0; vi < pos.count; vi++) {
    const vx = pos.getX(vi);
    const vz = pos.getZ(vi);
    // Inverse-distance-weighted blend across the k nearest hex centers — smooth height and
    // color falloff instead of a hard per-hex boundary.
    let wsum = 0;
    let hsum = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    // Only the handful of centers within ~2 hex-widths actually matter; skipping the rest
    // keeps this O(vertices * nearby) instead of O(vertices * all tiles).
    for (const c of centers) {
      const dx = vx - c.x;
      const dz = vz - c.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > hexW * hexW * 4) continue;
      const w = 1 / (d2 + 0.05);
      wsum += w;
      hsum += w * c.height;
      r += w * c.color.r;
      g += w * c.color.g;
      b += w * c.color.b;
    }
    const h = wsum > 0 ? hsum / wsum : 0;
    pos.setY(vi, h);
    if (wsum > 0) {
      tmpColor.setRGB(r / wsum, g / wsum, b / wsum);
    } else {
      tmpColor.copy(palette[0]!);
    }
    colorArr[vi * 3] = tmpColor.r;
    colorArr[vi * 3 + 1] = tmpColor.g;
    colorArr[vi * 3 + 2] = tmpColor.b;
  }
  groundBlend.setAttribute("color", new THREE.BufferAttribute(colorArr, 3));
  groundBlend.computeVertexNormals();
  const groundBlendMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  const groundBlendMesh = new THREE.Mesh(groundBlend, groundBlendMat);
  groundBlendMesh.receiveShadow = true;
  groundBlendMesh.castShadow = true;
  scene.add(groundBlendMesh);

  // Gameplay hex outline overlay — OFF by default, drawn only for tiles actually being
  // highlighted (movement range, spell AoE, hover). This is the only place hex edges appear.
  const outlinePts = hexPoints(HEX_SIZE * 0.94).map((p) => new THREE.Vector3(p.x, 0, p.y));
  outlinePts.push(outlinePts[0]!.clone());
  const outlineGeo = new THREE.BufferGeometry().setFromPoints(outlinePts);
  const outlineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
  const hexOutlineGroup = new THREE.Group();
  scene.add(hexOutlineGroup);
  function showHexOutline(col: number, row: number, color = 0xfff2a0) {
    const wx = col * hexW;
    const wz = row * hexH + (col % 2 === 1 ? hexH / 2 : 0);
    const line = new THREE.Line(outlineGeo, outlineMat.clone());
    (line.material as THREE.LineBasicMaterial).color.set(color);
    line.position.set(wx, 0.02, wz);
    hexOutlineGroup.add(line);
    return line;
  }
  function clearHexOutlines() {
    hexOutlineGroup.clear();
  }

  // Phase 2 — Contact shadow: a small, soft radial-gradient decal right at the caster's
  // feet, independent of the sun's shadow map — it exists purely to make the caster feel
  // planted where it meets the ground. A render-target mask/blur pipeline was tried first
  // and read as a noisy, irregular smudge instead of a clean soft shadow; this is the same
  // plain canvas-drawn radial-gradient sprite technique already proven elsewhere in this
  // codebase family for an equivalent "feet" effect — dark center fading smoothly to fully
  // transparent, no render targets, no blur passes, nothing that can misrender.
  const contactCanvas = document.createElement("canvas");
  contactCanvas.width = contactCanvas.height = 128;
  const contactCtx = contactCanvas.getContext("2d")!;
  const contactGradient = contactCtx.createRadialGradient(64, 64, 0, 64, 64, 64);
  contactGradient.addColorStop(0, "rgba(12,12,16,0.4)");
  contactGradient.addColorStop(0.5, "rgba(12,12,16,0.18)");
  contactGradient.addColorStop(1, "rgba(12,12,16,0)");
  contactCtx.fillStyle = contactGradient;
  contactCtx.fillRect(0, 0, 128, 128);
  const contactTexture = new THREE.CanvasTexture(contactCanvas);

  const contactDecalGeo = new THREE.PlaneGeometry(1, 1);
  contactDecalGeo.rotateX(-Math.PI / 2);
  const contactDecalMat = new THREE.MeshBasicMaterial({
    map: contactTexture,
    transparent: true,
    depthWrite: false,
  });
  const contactDecal = new THREE.Mesh(contactDecalGeo, contactDecalMat);
  contactDecal.scale.set(0.85, 1, 0.5); // wider than deep — a stance footprint, not a circle
  contactDecal.position.y = 0.012; // just above the terrain, below the hex outline overlay
  scene.add(contactDecal);

  let contactShadowsEnabled = true;
  function setContactShadows(enabled: boolean) {
    contactShadowsEnabled = enabled;
    contactDecal.visible = enabled;
  }

  function updateContactShadow() {
    // The terrain isn't flat, so this needs the real local ground height — a fixed y sat
    // under raised hexes and got depth-occluded by the terrain, making the whole effect
    // invisible.
    const groundY = terrainHeightAt(billboard.position.x, billboard.position.z);
    contactDecal.position.set(billboard.position.x, groundY + 0.012, billboard.position.z);
  }

  // Billboard: a camera-facing plane holding the character sprite. MeshStandardMaterial (not
  // MeshBasicMaterial) so it actually receives the sun's lighting and shadow like Triangle
  // Strategy's lit sprite characters, instead of looking like a flat unlit sticker.
  const billboardGeo = new THREE.PlaneGeometry(1.4, 1.4);
  const billboardMat = new THREE.MeshStandardMaterial({
    transparent: true,
    alphaTest: 0.5,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  const billboard = new THREE.Mesh(billboardGeo, billboardMat);
  billboard.position.set(hexW * 2, 0.75, hexH * 2);
  billboard.castShadow = true;
  billboard.receiveShadow = true;
  scene.add(billboard);

  function setBillboardTexture(tex: THREE.Texture) {
    tex.colorSpace = THREE.SRGBColorSpace;
    billboardMat.map = tex;
    billboardMat.needsUpdate = true;
  }

  function faceCameraYAxis() {
    // Y-axis-only billboarding: rotate to face the camera around Y only, so the sprite stays
    // upright on the ground plane instead of tilting with the camera's downward angle.
    const dx = camera.position.x - billboard.position.x;
    const dz = camera.position.z - billboard.position.z;
    billboard.rotation.y = Math.atan2(dx, dz);
  }
  faceCameraYAxis();

  // Phase 1 — PCF soft shadow filtering, toggleable for A/B comparison against the
  // unfiltered baseline from the same camera position. Swapping renderer.shadowMap.type
  // alone doesn't change already-compiled shadow-sampling shaders, so force every
  // material to recompile; nothing about the light, shadow camera or map size moves.
  let pcfSoft = true;
  function setPcfSoftShadows(enabled: boolean) {
    if (pcfSoft === enabled) return;
    pcfSoft = enabled;
    renderer.shadowMap.type = enabled ? THREE.PCFShadowMap : THREE.BasicShadowMap;
    renderer.shadowMap.needsUpdate = true;
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of materials) mat.needsUpdate = true;
    });
  }

  function resize(w: number, h: number) {
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }

  function dispose() {
    groundBlend.dispose();
    groundBlendMat.dispose();
    outlineGeo.dispose();
    outlineMat.dispose();
    groundGeo.dispose();
    groundMat.dispose();
    billboardGeo.dispose();
    billboardMat.dispose();
    contactTexture.dispose();
    contactDecalGeo.dispose();
    contactDecalMat.dispose();
    renderer.dispose();
  }

  let raf = 0;
  function loop() {
    faceCameraYAxis();
    if (contactShadowsEnabled) updateContactShadow();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return {
    renderer,
    scene,
    camera,
    setBillboardTexture,
    showHexOutline,
    clearHexOutlines,
    setPcfSoftShadows,
    setContactShadows,
    resize,
    dispose: () => {
      cancelAnimationFrame(raf);
      dispose();
    },
  };
}
