import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { createScene3D, type Scene3DHandle } from "../game/gfx3d/Scene3D";

declare global {
  interface Window {
    __gfx3d?: Scene3DHandle;
  }
}

function Test3D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pcfSoft, setPcfSoft] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handle = createScene3D(canvas, 8, 8);
    window.__gfx3d = handle; // console/Playwright hook for dev-toggle A/B testing
    const resize = () => handle.resize(window.innerWidth, window.innerHeight);
    resize();
    window.addEventListener("resize", resize);

    // Dev toggle: press "1" to A/B PCF soft shadow filtering vs. the hard-edge baseline.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "1") return;
      setPcfSoft((prev) => {
        const next = !prev;
        handle.setPcfSoftShadows(next);
        return next;
      });
    };
    window.addEventListener("keydown", onKey);

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
      window.removeEventListener("keydown", onKey);
      delete window.__gfx3d;
      handle.dispose();
    };
  }, []);

  return (
    <>
      <canvas ref={canvasRef} style={{ width: "100vw", height: "100vh", display: "block" }} />
      <div
        style={{
          position: "fixed",
          top: 8,
          left: 8,
          padding: "4px 8px",
          background: "rgba(0,0,0,0.6)",
          color: "#fff",
          font: "12px monospace",
          borderRadius: 4,
        }}
      >
        PCF soft shadows: {pcfSoft ? "ON" : "OFF"} (press 1 to toggle)
      </div>
    </>
  );
}

export const Route = createFileRoute("/test3d")({ component: Test3D });
