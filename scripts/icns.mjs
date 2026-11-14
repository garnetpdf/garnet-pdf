// The Mac icon file format (.icns): the container and the compressed form of its two smallest
// pictures. Nothing here needs anything but Node itself, so the checks on the build machines can
// read an icon file without the drawing tools that scripts/icons.mjs uses to make one.
import { Buffer } from 'node:buffer';

/**
 * One colour channel in the compressed form Mac icons use (it is close to PackBits): a byte of 128
 * or more says "the next byte, repeated (byte - 125) times"; a smaller one says "the next
 * (byte + 1) bytes as they are".
 */
export function icnsRle(bytes) {
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    let run = 1;
    while (i + run < bytes.length && run < 130 && bytes[i + run] === bytes[i]) run++;
    if (run >= 3) {
      out.push(run + 125, bytes[i]);
      i += run;
      continue;
    }
    // Bytes that do not repeat: at most 128, ending where the next run of three starts.
    const start = i;
    while (i < bytes.length && i - start < 128) {
      if (i + 2 < bytes.length && bytes[i] === bytes[i + 1] && bytes[i] === bytes[i + 2]) break;
      i++;
    }
    out.push(i - start - 1, ...bytes.subarray(start, i));
  }
  return Buffer.from(out);
}

/** The reverse of `icnsRle`: `length` bytes from compressed data, and where reading stopped. */
export function icnsUnRle(data, at, length) {
  const out = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    if (at >= data.length) throw new Error('The compressed icon data ends too early.');
    const control = data[at++];
    if (control >= 128) {
      const count = control - 125;
      if (filled + count > length || at >= data.length)
        throw new Error('A run in the compressed icon data crosses the end of its channel.');
      out.fill(data[at++], filled, filled + count);
      filled += count;
    } else {
      const count = control + 1;
      if (filled + count > length || at + count > data.length)
        throw new Error('Bytes in the compressed icon data cross the end of their channel.');
      data.copy(out, filled, at, at + count);
      at += count;
      filled += count;
    }
  }
  return { bytes: out, at };
}

/**
 * A small picture (16 or 32 px) of a Mac icon as `iconutil` stores it: the letters ARGB, then the
 * see-through channel and the three colours, each compressed on its own. `rgba` is the picture as
 * plain red, green, blue, alpha bytes.
 *
 * These two sizes must not be stored as PNG. The format has type names for that (icp4, icp5), but
 * macOS reads their data as plain colour bytes and draws coloured noise: in the title bar of the
 * disk image window, in Finder lists and in the Keychain question, on every screen that is not
 * Retina.
 */
export function icnsArgb(rgba, size) {
  const plane = size * size;
  if (rgba.length !== plane * 4)
    throw new Error(`A ${size} px icon needs ${plane * 4} bytes, got ${rgba.length}.`);
  const channel = (offset) => {
    const bytes = Buffer.alloc(plane);
    for (let i = 0; i < plane; i++)
      // Nothing shows where the picture is fully see-through: the colour there is left at zero.
      bytes[i] = offset === 3 || rgba[i * 4 + 3] ? rgba[i * 4 + offset] : 0;
    return icnsRle(bytes);
  };
  return Buffer.concat([
    Buffer.from('ARGB', 'latin1'),
    channel(3),
    channel(0),
    channel(1),
    channel(2),
  ]);
}

/** The picture inside an ARGB entry, as plain red, green, blue, alpha bytes. */
export function icnsArgbPixels(data, size) {
  if (data.toString('latin1', 0, 4) !== 'ARGB') throw new Error('Not an ARGB icon picture.');
  const plane = size * size;
  const rgba = Buffer.alloc(plane * 4);
  let at = 4;
  for (const offset of [3, 0, 1, 2]) {
    const channel = icnsUnRle(data, at, plane);
    at = channel.at;
    for (let i = 0; i < plane; i++) rgba[i * 4 + offset] = channel.bytes[i];
  }
  if (at !== data.length) throw new Error('The ARGB icon picture has bytes left over.');
  return rgba;
}

/** The entries of a Mac .icns file: four-letter type and the bytes of each. */
export function icnsEntries(file) {
  if (file.toString('latin1', 0, 4) !== 'icns' || file.readUInt32BE(4) !== file.length)
    throw new Error('Not a Mac icon file.');
  const entries = [];
  for (let at = 8; at + 8 <= file.length;) {
    const length = file.readUInt32BE(at + 4);
    if (length < 8 || at + length > file.length) throw new Error('Damaged Mac icon file.');
    entries.push({
      type: file.toString('latin1', at, at + 4),
      data: file.subarray(at + 8, at + length),
    });
    at += length;
  }
  return entries;
}

/** A Mac .icns file. `entries` is a list of [four-letter type, bytes of the picture]. */
export function icns(entries) {
  const chunks = entries.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'latin1');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'latin1');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}
