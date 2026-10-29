import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assetDirectory = path.join(root, "store-assets");
const sourcePath = path.join(assetDirectory, "small-promo.svg");
const outputPath = path.join(assetDirectory, "small-promo.png");

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 440, height: 280 } });
  await page.goto(pathToFileURL(sourcePath).href, { waitUntil: "load" });
  await page.screenshot({ path: outputPath, type: "png" });
} finally {
  await browser.close();
}
