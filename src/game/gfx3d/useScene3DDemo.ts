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

    const loader = new THREE.TextureLoader();
    loader.load("/spritesheet.png", (tex) => {
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      // Show just the first idle frame: crop via UV offset/repeat (12 cols x 5 rows grid).
      tex.repeat.set(1 / 12, 1 / 5);
      tex.offset.set(0, 4 / 5);
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

  return { canvasRef, pcfSoft, setPcfSoft, contactShadows, setContactShadows };
}

declare global {
  interface Window {
    __gfx3d?: Scene3DHandle;
  }
}
