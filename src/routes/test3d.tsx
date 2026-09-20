import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { createScene3D } from "../game/gfx3d/Scene3D";

function Test3D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = createScene3D(canvas, 8, 8);
    const resize = () => handle.resize(window.innerWidth, window.innerHeight);
    resize();
    window.addEventListener("resize", resize);

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
      window.removeEventListener("resize", resize);
      handle.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} style={{ width: "100vw", height: "100vh", display: "block" }} />;
}

export const Route = createFileRoute("/test3d")({ component: Test3D });
