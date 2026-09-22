import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { createScene3D, type Scene3DHandle } from "./Scene3D";

/** Bootstraps the HD-2D proof-of-concept scene into a canvas and exposes its dev-only
 * shadow-quality toggles as React state, so any screen (the standalone /test3d route, or
 * an in-game Dev Controls panel) can mount the same scene without repeating the setup. */
export function useScene3DDemo() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<Scene3DHandle | null>(null);
  const [pcfSoft, setPcfSoftState] = useState(true);
  const [contactShadows, setContactShadowsState] = useState(true);
  const [gtao, setGTAOState] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = createScene3D(canvas, 8, 8);
    handleRef.current = handle;
    window.__gfx3d = handle; // console/Playwright hook for dev-toggle A/B testing

    const resize = () => handle.resize(canvas.clientWidth, canvas.clientHeight);
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // A real hero's own idle frame (Kael) — the old /spritesheet.png this pulled from
    // turned out to be an unrelated monster placeholder sheet, not a character.
    const loader = new THREE.TextureLoader();
    loader.load("/game/sprites/kael/1.png", (tex) => {
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      handle.setBillboardTexture(tex);
    });

    // Prove the overlay system: highlight a small cluster of hexes like a movement range,
    // with the grid otherwise invisible everywhere else on the board.
    for (const [c, r] of [
      [3, 3],
      [4, 3],
      [3, 4],
      [4, 4],
      [5, 3],
    ]) {
      handle.showHexOutline(c, r, 0x9fd8ff);
    }

    return () => {
      ro.disconnect();
      handleRef.current = null;
      delete window.__gfx3d;
      handle.dispose();
    };
  }, []);

  function setPcfSoft(enabled: boolean) {
    setPcfSoftState(enabled);
    handleRef.current?.setPcfSoftShadows(enabled);
  }

  function setContactShadows(enabled: boolean) {
    setContactShadowsState(enabled);
    handleRef.current?.setContactShadows(enabled);
  }

  function setGTAO(enabled: boolean) {
    setGTAOState(enabled);
    handleRef.current?.setGTAO(enabled);
  }

  return { canvasRef, pcfSoft, setPcfSoft, contactShadows, setContactShadows, gtao, setGTAO };
}

declare global {
  interface Window {
    __gfx3d?: Scene3DHandle;
  }
}
