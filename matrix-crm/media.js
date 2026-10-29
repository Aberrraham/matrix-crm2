'use strict';
// Checks what an uploaded file really is (by its first bytes, never by its name)
// and prepares photos: fixes rotation, shrinks them, and removes hidden data such as GPS location.
const sharp = require('sharp');

// Photo formats from newer phones that we cannot read.
const UNREADABLE_PHOTO_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis']);

function sniff(buf) {
  if (buf.length < 12) return null;
  const ascii = (a, b) => buf.toString('latin1', a, b);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image' };                    // JPEG
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: 'image' }; // PNG
  if (ascii(0, 4) === 'GIF8') return { kind: 'image' };                                                      // GIF
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { kind: 'image' };                           // WebP
  if (ascii(4, 8) === 'ftyp') {                                                                              // MP4 / MOV (and HEIC, which we refuse)
    const brand = ascii(8, 12).trim().toLowerCase();
    if (UNREADABLE_PHOTO_BRANDS.has(brand)) return { kind: 'unsupported' };
    return brand === 'qt'
      ? { kind: 'video', contentType: 'video/quicktime', ext: 'mov' }
      : { kind: 'video', contentType: 'video/mp4', ext: 'mp4' };
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {                            // WebM
    return { kind: 'video', contentType: 'video/webm', ext: 'webm' };
  }
  return null;
}

// Returns { display, thumb } as JPEG buffers. Throws if the file is not a readable photo.
async function processImage(buf) {
  const open = () => sharp(buf, { limitInputPixels: 100e6, failOn: 'error' }).rotate(); // rotate() applies the camera's rotation
  const meta = await sharp(buf, { limitInputPixels: 100e6 }).metadata();
  if (!['jpeg', 'png', 'webp', 'gif'].includes(meta.format)) throw new Error('unsupported photo format');
  const white = { background: '#ffffff' };
  const display = await open()
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .flatten(white).jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  const thumb = await open()
    .resize({ width: 480, height: 480, fit: 'cover' })
    .flatten(white).jpeg({ quality: 75 }).toBuffer();
  return { display, thumb }; // sharp drops EXIF/GPS unless asked to keep it
}

module.exports = { sniff, processImage };
