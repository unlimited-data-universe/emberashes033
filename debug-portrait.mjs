// One-shot diagnostic for the missing Neera portrait in the battle intro dialog.
// Run with:  node debug-portrait.mjs
// (from the project root, i.e. C:\emberashes03D-main)
//
// This opens a REAL, visible Chromium window pointed at your dev server
// (http://localhost:8080). Play normally in that window: debug mode -> pick a
// map style -> start mission 1 -> let Neera's intro line pop up. The script
// logs every console message, every failed/portrait-related network request,
// and the live DOM state of the portrait <img> (if it exists at all) to
// portrait-debug.log, right next to this script.
//
// When you've seen (or not seen) the portrait, just close the window or hit
// Ctrl+C in the terminal, then send me portrait-debug.log.

import { chromium } from "playwright";
import { writeFileSync, appendFileSync } from "node:fs";

const LOG_FILE = new URL("./portrait-debug.log", import.meta.url);

writeFileSync(LOG_FILE, `=== Portrait debug session started ${new Date().toISOString()} ===\n`);

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    appendFileSync(LOG_FILE, stamped + "\n");
  } catch {
    // ignore
  }
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

page.on("console", (msg) => log(`CONSOLE [${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => log(`PAGEERROR ${err.message}`));
page.on("requestfailed", (req) => {
  log(`REQUEST FAILED ${req.method()} ${req.url()} -- ${req.failure()?.errorText ?? "unknown"}`);
});
page.on("response", (res) => {
  const url = res.url();
  if (url.toLowerCase().includes("portrait") || url.toLowerCase().includes("neera") || res.status() >= 400) {
    log(`RESPONSE ${res.status()} ${url}`);
  }
});

try {
  await page.goto("http://localhost:8080", { waitUntil: "domcontentloaded" });
  log("Page loaded. Play through to Neera's intro dialog now in this window.");
} catch (err) {
  log(`FAILED TO LOAD http://localhost:8080 -- ${err.message}`);
  log("Make sure the dev server (npm run dev) is actually running before you launch this script.");
}

let lastDialogSignature = "";
let lastPortraitSignature = "";

// Poll for any <img> anywhere on the page whose src mentions "portrait"/"neera" —
// catches the case where the element exists but never finishes loading.
setInterval(async () => {
  try {
    const info = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      return imgs
        .filter((img) => img.src.includes("portrait") || img.src.includes("neera"))
        .map((img) => ({
          src: img.src,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          clientWidth: img.clientWidth,
          clientHeight: img.clientHeight,
          className: img.className,
          visible: img.offsetParent !== null,
        }));
    });
    const sig = JSON.stringify(info);
    if (info.length > 0 && sig !== lastPortraitSignature) {
      lastPortraitSignature = sig;
      log(`PORTRAIT IMG STATE: ${sig}`);
    }
  } catch {
    // page may be navigating; ignore transient errors
  }
}, 1000);

// Poll for the DialogOverlay itself (.ember-veil), and dump its contents whenever
// it opens or its content changes — this tells us directly whether React even
// rendered the <img> element in the first place.
setInterval(async () => {
  try {
    const dialogInfo = await page.evaluate(() => {
      const veil = document.querySelector(".ember-veil");
      if (!veil) return null;
      const imgs = Array.from(veil.querySelectorAll("img")).map((img) => ({
        src: img.src,
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        outerHTML: img.outerHTML.slice(0, 300),
      }));
      const speaker = veil.querySelector("p")?.textContent ?? null;
      return { imgCount: imgs.length, imgs, speaker, veilHTML: veil.innerHTML.slice(0, 2000) };
    });
    const sig = dialogInfo ? JSON.stringify(dialogInfo) : "closed";
    if (sig !== lastDialogSignature) {
      lastDialogSignature = sig;
      log(dialogInfo ? `DIALOG OPEN: ${sig}` : "DIALOG CLOSED");
    }
  } catch {
    // ignore
  }
}, 750);

log("Watching for the dialog + portrait <img> state. Leave this window open and play up to Neera's line.");
log("When done, close this window or press Ctrl+C in the terminal, then send portrait-debug.log.");

// Keep the process alive until the window is closed.
await new Promise((resolve) => {
  page.on("close", resolve);
  browser.on("disconnected", resolve);
});
log("Browser closed. Session ended.");
process.exit(0);
