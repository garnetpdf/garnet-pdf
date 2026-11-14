// Writes resources/THIRD-PARTY-NOTICES.txt: every package that ships inside the app, with its licence text.
// Run before packaging (npm run notices). The list comes from the installed production dependency tree plus
// the libraries that are compiled into the window's code.
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';

const compiledIn = [
  'react',
  'react-dom',
  'scheduler',
  'lucide-react',
  'zustand',
  'harfbuzzjs',
  'bidi-js',
  'electron',
];
// Every installed copy of a production package, nested ones too: a library can be present in two versions.
const installed = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
  encoding: 'utf8',
  maxBuffer: 64e6,
})
  .split('\n')
  .filter(Boolean)
  .map((path) => relative(process.cwd(), path))
  .filter((path) => path.includes('node_modules'));
const nameOf = (dir) => dir.split('node_modules/').pop();
const places = [...new Set([...installed, ...compiledIn.map((name) => join('node_modules', name))])]
  .filter((dir) => !nameOf(dir).startsWith('@garnet/'))
  .filter((dir) => !nameOf(dir).startsWith('@napi-rs/')) // optional drawing add-on of pdf.js: not shipped
  .sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || a.localeCompare(b));

const parts = [
  'Garnet PDF: third-party notices',
  '',
  'Garnet PDF is free software under the GNU Affero General Public License, version 3 (see LICENSE.txt).',
  'It is built with the software and fonts listed below. Each belongs to its own authors and is used under',
  'its own licence, reproduced here. Chromium and its components are covered by LICENSES.chromium.html, which',
  'is installed next to the application (on a Mac: inside it, in Contents/Resources).',
  '',
];
// Where a package's own fields point at a manual, or it ships without a licence file.
const SOURCE = {
  mupdf:
    'https://cgit.ghostscript.com/mupdf.git/ (mirror: https://github.com/ArtifexSoftware/mupdf); ' +
    'JavaScript package: https://www.npmjs.com/package/mupdf',
};
const EXTRA = {
  mupdf: [
    'Copyright (C) Artifex Software, Inc.',
    'Garnet PDF uses this package unchanged. MuPDF itself includes open-source libraries such as FreeType,',
    'HarfBuzz, OpenJPEG, libjpeg, Little CMS, jbig2dec, zlib and Gumbo, and fonts including the URW base',
    'fonts. Each is under its own licence, found in the MuPDF source code (the thirdparty and',
    'resources/fonts folders).',
    '',
  ],
};
// The copyright line of the upstream licence file, for packages published without one.
const HOLDER = { fontkit: '2014-present Devon Govett' };
const mit = (holder) =>
  [
    'MIT License',
    '',
    `Copyright (c) ${holder}`,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and',
    'associated documentation files (the "Software"), to deal in the Software without restriction, including',
    'without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the',
    'following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in all copies or substantial',
    'portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT',
    'LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO',
    'EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER',
    'IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR',
    'THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
  ].join('\n');
let count = 0;
for (const dir of places) {
  if (!existsSync(join(dir, 'package.json'))) continue;
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licence = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || 'see text';
  const home =
    SOURCE[pkg.name] ||
    pkg.homepage ||
    (typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url) ||
    '';
  const author = (typeof pkg.author === 'string' ? pkg.author : pkg.author?.name || '')
    .replace(/\s*<[^>]*>/, '')
    .trim();
  const file = readdirSync(dir).find((f) => /^(licen[sc]e|copying)(\.|$)/i.test(f));
  parts.push(
    '='.repeat(100),
    `${pkg.name} ${pkg.version}`,
    `Licence: ${licence}`,
    home ? `Source: ${home}` : '',
    '',
  );
  if (EXTRA[pkg.name]) parts.push(...EXTRA[pkg.name]);
  // The AGPL text is the same as LICENSE.txt; do not repeat 660 lines.
  if (/AGPL/.test(licence))
    parts.push('GNU Affero General Public License: the full text is in LICENSE.txt.');
  else if (file) parts.push(readFileSync(join(dir, file), 'utf8').trim());
  else if (licence === 'MIT' && (HOLDER[pkg.name] || author))
    parts.push(mit(HOLDER[pkg.name] || author));
  else throw new Error(`${pkg.name}: no licence text to reproduce (${licence})`);
  parts.push('');
  count++;
}
parts.push(
  '='.repeat(100),
  'The Windows installer',
  '',
  'The installer is made with NSIS (Nullsoft Scriptable Install System, https://nsis.sourceforge.io, zlib/libpng',
  'licence) through electron-builder (MIT licence). It carries these NSIS plug-ins. They run only while',
  'installing and are not part of the installed application:',
  '',
  '- 7-Zip NSIS plug-in. Copyright (c) 1999-2016 Igor Pavlov, Nik Medved, Marek Mizanin, Stuart Welch.',
  '  GNU Lesser General Public License. Source: https://www.7-zip.org',
  '- StdUtils plug-in. Copyright (C) 2004-2018 LoRd_MuldeR. GNU Lesser General Public License, version 2.1 or',
  '  later. Source: https://github.com/lordmulder/stdutils',
  '- UAC and WinShell plug-ins, from the NSIS plug-in collection at https://nsis.sourceforge.io',
  '',
  readFileSync('resources/licences/LGPL-2.1.txt', 'utf8').trim(),
  '',
);
count++;
parts.push(
  '='.repeat(100),
  'The Mac application',
  '',
  'The Mac disk image is made with the tools of macOS through electron-builder (MIT licence); nothing of',
  'them is installed. On a Mac the application carries three small frameworks that are part of Electron:',
  'Squirrel.Mac (its notice is in LICENSES.chromium.html), Mantle and ReactiveObjC. Garnet PDF does not',
  'use them: it never looks for updates.',
  '',
  '-'.repeat(100),
  'Mantle',
  'Source: https://github.com/Mantle/Mantle',
  '',
  readFileSync('resources/licences/Mantle-LICENSE.txt', 'utf8').trim(),
  '',
  '-'.repeat(100),
  'ReactiveObjC',
  'Source: https://github.com/ReactiveCocoa/ReactiveObjC',
  '',
  readFileSync('resources/licences/ReactiveObjC-LICENSE.txt', 'utf8').trim(),
  '',
);
count++;
parts.push('='.repeat(100), 'Fonts installed with the application', '');
for (const file of readdirSync('resources/fonts')
  .filter((f) => /(LICENSE|OFL)\.txt$/i.test(f))
  .sort()) {
  parts.push(
    '-'.repeat(100),
    file.replace(/-(LICENSE|OFL)\.txt$/i, ''),
    '',
    readFileSync(join('resources/fonts', file), 'utf8').trim(),
    '',
  );
  count++;
}
writeFileSync('resources/THIRD-PARTY-NOTICES.txt', parts.join('\n') + '\n');
console.log(`notices: ${count} entries`);
