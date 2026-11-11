/**
 * Builds the phone app's icons (renderer/mobile/icons) from the desktop icon sources in assets/.
 *
 *   icon-192.png, icon-512.png   manifest "any" icons: the rounded tile (icon.svg), transparent corners
 *   icon-maskable-512.png        manifest "maskable": full bleed (icon-maskable.svg). The ears and eyes sit inside the
 *                                central safe circle (80% diameter), so Android's adaptive-icon mask never cuts into them
 *   apple-touch-icon.png         iPhone home screen: the tile's square, full-bleed version (icon-square.svg); iOS rounds
 *                                the corners itself
 *
 * Run after changing the icon SVGs (after scripts/build-icons.mjs):
 *   node apps/desktop/scripts/build-mobile-icons.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from '../../../node_modules/sharp/lib/index.js';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(desktopRoot, 'assets');
const outDir = path.join(desktopRoot, 'renderer', 'mobile', 'icons');

const png = (img) => img.png({ compressionLevel: 9, adaptiveFiltering: true, palette: true, quality: 90, effort: 10 });
// Rasterize at four times the target size, then downsample, so edges stay smooth.
const render = (file, size) =>
  sharp(fs.readFileSync(path.join(assetsDir, file)), { density: Math.max(72, (72 * size * 4) / 512) }).resize(size, size);

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const outputs = {
    'icon-192.png': png(render('icon.svg', 192)),
    'icon-512.png': png(render('icon.svg', 512)),
    'icon-maskable-512.png': png(render('icon-maskable.svg', 512)),
    'apple-touch-icon.png': png(render('icon-square.svg', 180)),
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
