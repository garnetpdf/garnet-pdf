// Builds every icon and logo file from the two vector drawings in resources/:
//
//   resources/icon.png, resources/icon.ico      Windows and Linux (the red tile as drawn)
//   resources/icon.icns                         Mac: the same drawing in the Mac icon shape
//   resources/appx/*.png                        the logos inside the Microsoft Store package
//   resources/store/*.png                       the logos uploaded with the Store listing
//   resources/dmg-background.png, ...@2x.png    the window of the Mac disk image
//
// Sizes up to 32 px use the simplified drawing (icon-small.svg) so that small icons stay clear.
// Run: node scripts/icons.mjs
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import sharp from 'sharp';
import { icns, icnsArgb, icnsArgbPixels, icnsEntries, icnsRle, icnsUnRle } from './icns.mjs';

const LARGE = 'resources/icon.svg';
const SMALL = 'resources/icon-small.svg';
const sourceFor = (size) => (size <= 32 ? SMALL : LARGE);

/** One square PNG of a drawing (a file name or the text of an SVG). */
const render = (svg, size) =>
  sharp(typeof svg === 'string' && svg.trimStart().startsWith('<') ? Buffer.from(svg) : svg, {
    density: Math.max(72, Math.ceil((72 * size * 2) / 1024)),
  })
    .resize(size, size)
    .png()
    .toBuffer();

// ---------------------------------------------------------------------------------------------
// Windows: .ico with every size Windows asks for

export function ico(sizes, images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const entries = Buffer.alloc(16 * sizes.length);
  let offset = header.length + entries.length;
  sizes.forEach((size, i) => {
    const at = 16 * i;
    entries.writeUInt8(size === 256 ? 0 : size, at); // width, 0 means 256
    entries.writeUInt8(size === 256 ? 0 : size, at + 1); // height
    entries.writeUInt16LE(1, at + 4); // colour planes
    entries.writeUInt16LE(32, at + 6); // bits per pixel
    entries.writeUInt32LE(images[i].length, at + 8);
    entries.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, entries, ...images]);
}

// ---------------------------------------------------------------------------------------------
// Mac: the icon shape

/**
 * The outline Apple uses for app icons: a square whose corners curve in gradually (not a quarter
 * circle). `radius` is the corner radius in Apple's sense. The numbers are the well-known Bezier
 * approximation of that curve.
 */
export function macTilePath(x, y, width, height, radius) {
  const r = Math.min(radius, Math.min(width, height) / 2 / 1.528665);
  const n = (value) => Number(value.toFixed(3));
  // Offsets along one corner, as multiples of the radius: where the curve starts on the straight
  // edge, then the control points and end points of its three segments.
  const [a, b, c, d, e, f, g] = [
    1.528665, 1.08849296, 0.86840694, 0.63149379, 0.07491139, 0.37282383, 0.16905956,
  ].map((value) => value * r);
  const right = x + width;
  const bottom = y + height;
  const p = (px, py) => `${n(px)} ${n(py)}`;
  return [
    `M${p(x + a, y)}`,
    `L${p(right - a, y)}`,
    `C${p(right - b, y)} ${p(right - c, y)} ${p(right - d, y + e)}`,
    `C${p(right - f, y + g)} ${p(right - g, y + f)} ${p(right - e, y + d)}`,
    `C${p(right, y + c)} ${p(right, y + b)} ${p(right, y + a)}`,
    `L${p(right, bottom - a)}`,
    `C${p(right, bottom - b)} ${p(right, bottom - c)} ${p(right - e, bottom - d)}`,
    `C${p(right - g, bottom - f)} ${p(right - f, bottom - g)} ${p(right - d, bottom - e)}`,
    `C${p(right - c, bottom)} ${p(right - b, bottom)} ${p(right - a, bottom)}`,
    `L${p(x + a, bottom)}`,
    `C${p(x + b, bottom)} ${p(x + c, bottom)} ${p(x + d, bottom - e)}`,
    `C${p(x + f, bottom - g)} ${p(x + g, bottom - f)} ${p(x + e, bottom - d)}`,
    `C${p(x, bottom - c)} ${p(x, bottom - b)} ${p(x, bottom - a)}`,
    `L${p(x, y + a)}`,
    `C${p(x, y + b)} ${p(x, y + c)} ${p(x + e, y + d)}`,
    `C${p(x + g, y + f)} ${p(x + f, y + g)} ${p(x + d, y + e)}`,
    `C${p(x + c, y)} ${p(x + b, y)} ${p(x + a, y)}`,
    'Z',
  ].join(' ');
}

/** Apple's icon grid on a 1024 px canvas: the tile is 824 px wide with a 100 px margin all round. */
export const MAC_GRID = { canvas: 1024, tile: 824, margin: 100, radius: 185.4 };
// The tile as it is drawn in icon.svg and icon-small.svg.
const DRAWN = { x: 64, y: 56, size: 896, inset: 3 };

/**
 * The drawing as a Mac icon: the red tile gets Apple's corner shape and is scaled into Apple's grid
 * (so it lines up with the other icons in the Dock); everything on the tile scales with it.
 */
export function macIconSvg(svg) {
  const scale = MAC_GRID.tile / DRAWN.size;
  const radius = MAC_GRID.radius / scale;
  let shapes = 0;
  const { x, y, size, inset } = DRAWN;
  const tile = `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="208"`;
  const rim = `<rect x="${x + inset}" y="${y + inset}" width="${size - 2 * inset}" height="${size - 2 * inset}" rx="205"`;
  let out = svg.replaceAll(tile, () => {
    shapes++;
    return `<path d="${macTilePath(x, y, size, size, radius)}"`;
  });
  out = out.replaceAll(rim, () => {
    shapes++;
    return `<path d="${macTilePath(x + inset, y + inset, size - 2 * inset, size - 2 * inset, radius - inset)}"`;
  });
  // The shadow, the tile, the clip for the gloss, and the rim.
  if (shapes !== 4)
    throw new Error(`The icon drawing changed: expected 4 tile shapes, found ${shapes}.`);
  if (!out.includes('</defs>') || !out.trimEnd().endsWith('</svg>'))
    throw new Error('The icon drawing changed: no </defs> or </svg> where expected.');
  const move = `translate(${MAC_GRID.margin} ${MAC_GRID.margin}) scale(${Number(scale.toFixed(6))}) translate(${-x} ${-y})`;
  return out
    .replace('</defs>', `</defs>\n  <g transform="${move}">`)
    .replace(/<\/svg>\s*$/, '</g>\n</svg>\n');
}

export { icns, icnsArgb, icnsArgbPixels, icnsEntries, icnsRle, icnsUnRle };

/**
 * The pictures of a Mac icon: type, size in pixels and form, as `iconutil` writes them. The two
 * smallest are stored as compressed colour channels ('argb'), all others as PNG.
 */
export const ICNS_TYPES = [
  ['ic04', 16, 'argb'],
  ['ic05', 32, 'argb'],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024], // 512 pt on a Retina screen
  ['ic11', 32], // 16 pt on a Retina screen
  ['ic12', 64], // 32 pt on a Retina screen
  ['ic13', 256], // 128 pt on a Retina screen
  ['ic14', 512], // 256 pt on a Retina screen
];

// ---------------------------------------------------------------------------------------------
// Microsoft Store package: the logos Windows shows for an installed Store app

const SCALES = [100, 125, 150, 200, 400];
/**
 * Every logo file of the Store package: name, size in pixels, and how much of the smaller side the
 * icon fills. Tiles keep free space round the icon, as Windows expects; the small "target size"
 * pictures are the icon itself (taskbar, Start list, file lists).
 */
export function storeAssets() {
  const files = [];
  const scaled = (name, width, height, fill) => {
    for (const scale of SCALES)
      files.push({
        name: `${name}.scale-${scale}.png`,
        width: Math.round((width * scale) / 100),
        height: Math.round((height * scale) / 100),
        fill,
      });
  };
  scaled('StoreLogo', 50, 50, 0.9);
  scaled('Square44x44Logo', 44, 44, 0.9);
  scaled('SmallTile', 71, 71, 0.72);
  scaled('Square150x150Logo', 150, 150, 0.62);
  scaled('Wide310x150Logo', 310, 150, 0.62);
  scaled('LargeTile', 310, 310, 0.62);
  for (const size of [16, 24, 32, 48, 256])
    for (const form of ['', '_altform-unplated', '_altform-lightunplated'])
      files.push({
        name: `Square44x44Logo.targetsize-${size}${form}.png`,
        width: size,
        height: size,
        fill: 1,
      });
  return files;
}

/** The icon centred on a clear (or coloured) canvas, filling `fill` of the smaller side. */
async function onCanvas(width, height, fill, background = { r: 0, g: 0, b: 0, alpha: 0 }) {
  const size = Math.max(1, Math.round(Math.min(width, height) * fill));
  const icon = await render(sourceFor(size), size);
  return sharp({ create: { width, height, channels: 4, background } })
    .composite([
      { input: icon, left: Math.round((width - size) / 2), top: Math.round((height - size) / 2) },
    ])
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------------------------
// Mac disk image: the window with the app on the left, the Applications folder on the right

/** The size of the window, and where the two icons sit in it (see dmg in electron-builder.yml). */
export const DMG = { width: 540, height: 380, app: { x: 140, y: 190 }, folder: { x: 400, y: 190 } };

/** A calm light background with an arrow from the app to the Applications folder. No words. */
export function dmgBackgroundSvg() {
  const { width, height, app, folder } = DMG;
  const y = app.y - 6;
  const from = app.x + 74;
  const to = folder.x - 74;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FBFBFD"/><stop offset="1" stop-color="#ECEEF3"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#ground)"/>
  <g fill="none" stroke="#B7BECB" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M${from} ${y} H${to}"/>
    <path d="M${to - 16} ${y - 15} L${to} ${y} L${to - 16} ${y + 15}"/>
  </g>
</svg>
`;
}

// ---------------------------------------------------------------------------------------------

async function main() {
  await writeFile('resources/icon.png', await render(LARGE, 512));
  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const icoImages = [];
  for (const size of icoSizes) icoImages.push(await render(sourceFor(size), size));
  await writeFile('resources/icon.ico', ico(icoSizes, icoImages));

  const macLarge = macIconSvg(await readFile(LARGE, 'utf8'));
  const macSmall = macIconSvg(await readFile(SMALL, 'utf8'));
  const macEntries = [];
  for (const [type, size, form] of ICNS_TYPES) {
    const png = await render(size <= 32 ? macSmall : macLarge, size);
    macEntries.push([
      type,
      form === 'argb' ? icnsArgb(await sharp(png).ensureAlpha().raw().toBuffer(), size) : png,
    ]);
  }
  await writeFile('resources/icon.icns', icns(macEntries));

  await rm('resources/appx', { recursive: true, force: true });
  await mkdir('resources/appx', { recursive: true });
  for (const { name, width, height, fill } of storeAssets())
    await writeFile(`resources/appx/${name}`, await onCanvas(width, height, fill));

  // For the Store listing (uploaded by hand, not part of the package): app tile icon, box art, poster.
  await mkdir('resources/store', { recursive: true });
  const paper = { r: 247, g: 248, b: 250, alpha: 1 };
  await writeFile('resources/store/AppTileIcon-300x300.png', await onCanvas(300, 300, 0.9));
  await writeFile('resources/store/BoxArt-1080x1080.png', await onCanvas(1080, 1080, 0.6, paper));
  await writeFile('resources/store/Poster-720x1080.png', await onCanvas(720, 1080, 0.62, paper));

  const background = dmgBackgroundSvg();
  for (const [file, factor] of [
    ['resources/dmg-background.png', 1],
    ['resources/dmg-background@2x.png', 2],
  ])
    await writeFile(
      file,
      await sharp(Buffer.from(background), { density: 72 * factor })
        .resize(DMG.width * factor, DMG.height * factor)
        .png()
        .toBuffer(),
    );
  console.log(
    `icons: icon.png, icon.ico, icon.icns (${ICNS_TYPES.length} sizes), ` +
      `${(await readdir('resources/appx')).length} Store package logos, 3 Store listing logos, 2 disk image backgrounds`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
