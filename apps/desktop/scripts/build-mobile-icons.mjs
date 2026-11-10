/**
 * Builds the phone app's icons (renderer/mobile/icons) from the desktop app icon (assets/icon-512.png).
 *
 *   icon-192.png, icon-512.png   manifest "any" icons (the round artwork, transparent corners)
 *   icon-maskable-512.png        manifest "maskable": the artwork inside the central safe circle on the app colour,
 *                                so Android's adaptive-icon mask never cuts into it
 *   apple-touch-icon.png         iPhone home screen: opaque, iOS rounds the corners itself
 *
 * Run after changing assets/icon-512.png:
 *   node apps/desktop/scripts/build-mobile-icons.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from '../../../node_modules/sharp/lib/index.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(desktopRoot, 'assets', 'icon-512.png');
const outDir = path.join(desktopRoot, 'renderer', 'mobile', 'icons');
const BACKGROUND = { r: 0x0e, g: 0x10, b: 0x13, alpha: 1 }; // --canvas in renderer/mobile/app.css

const png = (img) => img.png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 90, effort: 10 });

async function onCanvas(size, artwork) {
  const art = await sharp(source).resize(artwork, artwork, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  const offset = Math.round((size - artwork) / 2);
  return png(sharp({ create: { width: size, height: size, channels: 4, background: BACKGROUND } })
    .composite([{ input: art, left: offset, top: offset }]));
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const outputs = {
    'icon-192.png': png(sharp(source).resize(192, 192)),
    'icon-512.png': png(sharp(source).resize(512, 512)),
    // The maskable safe zone is the central circle of 80% diameter; the round artwork fills 78% of it.
    'icon-maskable-512.png': await onCanvas(512, 400),
    'apple-touch-icon.png': await onCanvas(180, 164),
  };
  for (const [name, img] of Object.entries(outputs)) {
    const file = path.join(outDir, name);
    await img.toFile(file);
    console.log(`${name}: ${fs.statSync(file).size} bytes`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
