// Renders design/icon/out/*.svg to PNG at the sizes Windows uses. Usage: node design/icon/render.mjs
import console from 'node:console';
import { readdirSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';
const dir = 'design/icon/out';
mkdirSync(`${dir}/png`, { recursive: true });
for (const file of readdirSync(dir).filter((f) => f.endsWith('.svg'))) {
  const name = file.replace('.svg', '');
  for (const size of name.endsWith('-small') ? [16, 20, 24, 32] : [1024, 512, 256, 128, 64, 48, 40, 32, 24, 16])
    await sharp(`${dir}/${file}`, { density: 72 * (Math.max(size, 256) / 1024) * 4 }).resize(size, size).png().toFile(`${dir}/png/${name}-${size}.png`);
}
console.log('rendered');
