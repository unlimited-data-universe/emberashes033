#!/usr/bin/env node
/**
 * Shadow-pipeline QA for the Ember Ashes CSM/contact-shadow/GTAO work.
 *
 *   node scripts/shadow-qa.mjs <label>          # against http://127.0.0.1:8080/
 *   node scripts/shadow-qa.mjs <label> <url>
 *
 * Constructs BattleEngine + ThreeBattleRenderer directly via module imports (same
 * pattern as scripts/qa-browser.mjs) rather than clicking through the title screen —
 * no menu navigation, no "playing" the game. Renders three fixed test scenes (open
 * terrain, beside a large prop, wide battlefield) and saves PNG screenshots under
 * screenshots/shadows/<label>-<scene>.png. Screenshots are never overwritten across
 * labels — pass a distinct label per phase/check so every prior capture stays on disk.
 * Also prints a frame-time budget for the wide-battlefield scene (the steady-state
 * frame cost, not the one-off warmup frame).
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { checkedUrl } from "./browser-guard.mjs";

const label = process.argv[2];
if (!label) {
  console.error("usage: node scripts/shadow-qa.mjs <label> [url]");
  process.exit(2);
}
const url = checkedUrl(process.argv[3] || "http://127.0.0.1:8080/");
const outDir = new URL("../screenshots/shadows/", import.meta.url);
mkdirSync(outDir, { recursive: true });

async function launchBrowser() {
  const args = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    // Headless Chromium needs an explicit software GL backend for WebGL to work
    // reliably off-screen; without this some builds silently fall back to a 2D
    // canvas context and every shadow/lighting screenshot comes out blank.
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ];
  try {
    return await chromium.launch({ headless: true, args });
  } catch (bundled) {
    try {
      return await chromium.launch({ channel: "chrome", headless: true, args });
    } catch {
      console.error(
        "[shadow-qa] no browser to drive. Either run `npx playwright install chromium`,\n" +
          "[shadow-qa] or install Chrome so the `chrome` channel can be used.\n" +
          `[shadow-qa] bundled chromium said: ${bundled.message.split("\n")[0]}`,
      );
      process.exit(2);
    }
  }
}

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text());
});

try {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
} catch (err) {
  console.error(`[shadow-qa] ${url} did not answer — is the dev server up? (${err.message.split("\n")[0]})`);
  await browser.close();
  process.exit(2);
}

const result = await page.evaluate(async () => {
  const { BattleEngine } = await import("/src/game/engine.ts");
  const { TILE_CHAR } = await import("/src/game/data.ts");
  const { ThreeBattleRenderer } = await import("/src/game/gfx/three/ThreeBattleRenderer.ts");
  const assets = await import("/src/game/assets.ts");

  const art = await assets.loadGameArt();
  const roster = { hp: {}, levels: {} };

  const layout = (cols, rows, fill = "plains") =>
    Array.from({ length: rows }, () => TILE_CHAR[fill].repeat(cols));

  const mission = (over) => ({
    id: "thebridge",
    index: 3,
    title: "shadow-qa",
    place: "QA",
    briefing: "",
    objective: "QA",
    win: "rout",
    cols: 20,
    rows: 16,
    layout: layout(20, 16),
    playerSpawns: [],
    enemySpawns: [],
    ...over,
  });

  const W = 1600;
  const H = 900;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  document.body.appendChild(canvas);

  async function captureScene(missionOver, { zoom = 0 } = {}) {
    const m = mission(missionOver);
    const eng = new BattleEngine(m, art, roster, 7);
    const renderer = new ThreeBattleRenderer(canvas, eng);
    renderer.setSize(W, H, 1);
    // First render primes updateCameraLayout's viewW/viewH; centerOnBoard() before that
    // would compute against stale defaults.
    renderer.render(W, H);
    if (zoom) eng.setZoom(zoom);
    eng.centerOnBoard();
    // A couple more frames so any async-loaded texture that wasn't ready on frame 1 gets
    // picked up (materialFor/unitTextureFor create GPU textures off already-loaded
    // HTMLImageElements, so this is just settling, not a real load wait).
    for (let i = 0; i < 3; i++) renderer.render(W, H);

    const frames = [];
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now();
      renderer.render(W, H);
      frames.push(performance.now() - t0);
    }
    const steady = frames.slice(1).sort((a, b) => a - b);

    return {
      dataUrl: canvas.toDataURL("image/png"),
      frameMedianMs: +steady[Math.floor(steady.length / 2)].toFixed(2),
      frameP95Ms: +steady[Math.floor(steady.length * 0.95)].toFixed(2),
    };
  }

  const out = {};

  // Scene A — open terrain, single character, nothing else around it.
  out.open = await captureScene({
    cols: 12,
    rows: 10,
    layout: layout(12, 10),
    playerSpawns: [{ name: "Kael", classId: "swordsman", x: 6, y: 5 }],
  });

  // Scene B — character beside a large prop/wall (a wall segment right next to the unit).
  out.wall = await captureScene({
    cols: 12,
    rows: 10,
    layout: layout(12, 10),
    playerSpawns: [{ name: "Kael", classId: "swordsman", x: 6, y: 5 }],
    decorations: [{ id: "broken-wall-segment", x: 7, y: 5 }],
  });

  // Scene C — wide battlefield view, many units, zoomed out.
  const names = ["Kael", "Neera", "Voss", "Salazar", "Malrec", "Aldric"];
  out.battlefield = await captureScene(
    {
      cols: 30,
      rows: 24,
      layout: layout(30, 24),
      playerSpawns: names.map((n, i) => ({ name: n, classId: "swordsman", x: 6 + i * 2, y: 18 })),
      enemySpawns: Array.from({ length: 12 }, (_, i) => ({
        name: `Foe${i}`,
        classId: i % 3 === 0 ? "archer" : "soldier",
        x: 4 + ((i * 3) % 24),
        y: 4 + ((i * 5) % 10),
      })),
      decorations: [
        { id: "broken-wall-segment", x: 10, y: 10 },
        { id: "large-boulder", x: 18, y: 8 },
      ],
    },
    { zoom: 2 },
  );

  return out;
});

if (pageErrors.length) {
  console.log(`[shadow-qa] ${pageErrors.length} page error(s):`);
  for (const e of pageErrors.slice(0, 10)) console.log(`[shadow-qa]   ${e}`);
}

for (const [scene, data] of Object.entries(result)) {
  const b64 = data.dataUrl.replace(/^data:image\/png;base64,/, "");
  const path = new URL(`${label}-${scene}.png`, outDir);
  writeFileSync(path, Buffer.from(b64, "base64"));
  console.log(`[shadow-qa] ${scene}: median ${data.frameMedianMs}ms, p95 ${data.frameP95Ms}ms -> ${path.pathname.replace(/^\//, "")}`);
}

await browser.close();
if (pageErrors.length) process.exit(1);
