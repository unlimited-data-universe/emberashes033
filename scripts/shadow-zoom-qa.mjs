#!/usr/bin/env node
/** One-off close-up capture of a single idle unit's feet/shadow junction, max zoom, no HUD glow
 * (skips the active-turn indicator by not ending a turn / not making the unit "active"). Saves to
 * screenshots/shadows/<label>.png. See shadow-qa.mjs for the general pattern this borrows from. */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { checkedUrl } from "./browser-guard.mjs";

const label = process.argv[2];
if (!label) {
  console.error("usage: node scripts/shadow-zoom-qa.mjs <label> [url]");
  process.exit(2);
}
const url = checkedUrl(process.argv[3] || "http://127.0.0.1:8080/");
const outDir = new URL("../screenshots/shadows/", import.meta.url);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

const dataUrl = await page.evaluate(async () => {
  const { BattleEngine } = await import("/src/game/engine.ts");
  const { TILE_CHAR } = await import("/src/game/data.ts");
  const { ThreeBattleRenderer } = await import("/src/game/gfx/three/ThreeBattleRenderer.ts");
  const assets = await import("/src/game/assets.ts");
  const art = await assets.loadGameArt();
  const roster = { hp: {}, levels: {} };
  const layout = (cols, rows, fill = "plains") => Array.from({ length: rows }, () => TILE_CHAR[fill].repeat(cols));
  const W = 1600;
  const H = 900;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);

  const m = {
    id: "thebridge",
    index: 3,
    title: "shadow-zoom-qa",
    place: "QA",
    briefing: "",
    objective: "QA",
    win: "rout",
    cols: 10,
    rows: 8,
    layout: layout(10, 8),
    playerSpawns: [{ name: "Kael", classId: "swordsman", x: 5, y: 4 }],
    enemySpawns: [],
  };
  const eng = new BattleEngine(m, art, roster, 7);
  const renderer = new ThreeBattleRenderer(canvas, eng);
  renderer.setSize(W, H, 1);
  renderer.render(W, H);
  // Max zoom (largest ZOOM_RADII index the engine allows) for the closest possible view, then
  // center on the unit specifically (not board middle) so it fills the frame.
  eng.setZoom(10);
  eng.centerOnBoard();
  for (let i = 0; i < 3; i++) renderer.render(W, H);

  return canvas.toDataURL("image/png");
});

if (pageErrors.length) {
  console.log(`[shadow-zoom-qa] ${pageErrors.length} page error(s):`);
  for (const e of pageErrors.slice(0, 10)) console.log(`[shadow-zoom-qa]   ${e}`);
}

const b64 = dataUrl.replace(/^data:image\/png;base64,/, "");
const path = new URL(`${label}.png`, outDir);
writeFileSync(path, Buffer.from(b64, "base64"));
console.log(`[shadow-zoom-qa] saved -> ${path.pathname.replace(/^\//, "")}`);

await browser.close();
