import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { useScene3DDemo } from "../game/gfx3d/useScene3DDemo";

function Test3D() {
  const { canvasRef, pcfSoft, setPcfSoft, contactShadows, setContactShadows, gtao, setGTAO } = useScene3DDemo();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "1") setPcfSoft(!pcfSoft);
      if (e.key === "2") setContactShadows(!contactShadows);
      if (e.key === "3") setGTAO(!gtao);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

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
          lineHeight: 1.6,
        }}
      >
        <div>PCF soft shadows: {pcfSoft ? "ON" : "OFF"} (press 1 to toggle)</div>
        <div>Contact shadows: {contactShadows ? "ON" : "OFF"} (press 2 to toggle)</div>
        <div>GTAO: {gtao ? "ON" : "OFF"} (press 3 to toggle)</div>
      </div>
    </>
  );
}

export const Route = createFileRoute("/test3d")({ component: Test3D });
