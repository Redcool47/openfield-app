#!/usr/bin/env node
/**
 * Extract one member out of a zip, without unpacking the rest.
 *
 * Used to pull app.asar out of a 170 MB MSIX. Reading the central directory and
 * copying a single member avoids writing several hundred megabytes of Electron
 * binaries to disk just to compare one file.
 *
 * This is a zip reader, not a general archiver: it assumes a classic (non-ZIP64)
 * central directory, which is what an MSIX under 4 GB contains. If ZIP64 is ever
 * hit the offsets read back as 0xffffffff and the entry lookup fails loudly
 * rather than silently producing a corrupt file.
 *
 * Usage: node tools/extract-zip-member.mjs <archive> <member> <out-file>
 */

import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const EOCD64_LOC_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

/** Locate the end-of-central-directory record by scanning backwards. */
function findEocd(buf) {
  const max = Math.min(buf.length, 0xffff + 22);
  for (let i = 22; i <= max; i += 1) {
    const at = buf.length - i;
    if (buf.readUInt32LE(at) === EOCD_SIG) return at;
  }
  throw new Error('not a zip: no end-of-central-directory record');
}

/**
 * Read the central directory and return one record per entry.
 *
 * ZIP64 is supported, and it is not optional here: an MSIX is written by .NET
 * tooling that emits ZIP64 extensions unconditionally, so even a 170 MB package
 * reports its entry count and offsets as 0xffffffff and carries the real values
 * in the ZIP64 records. A reader that ignores that sees a directory of length
 * four billion.
 */
function readDirectory(file) {
  const size = statSync(file).size;
  const fd = openSync(file, 'r');
  try {
    const tailLen = Math.min(size, 0xffff + 22 + 20);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    const eocd = findEocd(tail);

    let count = tail.readUInt16LE(eocd + 10);
    let dirSize = tail.readUInt32LE(eocd + 12);
    let dirOffset = tail.readUInt32LE(eocd + 16);

    const zip64 = dirOffset === 0xffffffff || dirSize === 0xffffffff || count === 0xffff;
    if (zip64) {
      // The ZIP64 locator sits immediately before the classic record.
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== EOCD64_LOC_SIG) {
        throw new Error('ZIP64 fields present but no ZIP64 end-of-central-directory locator');
      }
      const rec = Number(tail.readBigUInt64LE(loc + 8));
      const recBuf = Buffer.alloc(56);
      readSync(fd, recBuf, 0, 56, rec);
      if (recBuf.readUInt32LE(0) !== EOCD64_SIG) {
        throw new Error('ZIP64 end-of-central-directory record has a bad signature');
      }
      count = Number(recBuf.readBigUInt64LE(32));
      dirSize = Number(recBuf.readBigUInt64LE(40));
      dirOffset = Number(recBuf.readBigUInt64LE(48));
    }

    // Read the directory at its exact offset. Sizing a window that is guaranteed
    // to contain it means guessing at dirSize, and a guess that comes up short
    // reads past the end of the buffer.
    const dir = Buffer.alloc(dirSize);
    readSync(fd, dir, 0, dirSize, dirOffset);

    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i += 1) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== CEN_SIG) break;

      const method = dir.readUInt16LE(p + 10);
      const nameLen = dir.readUInt16LE(p + 28);
      const extraLen = dir.readUInt16LE(p + 30);
      const commentLen = dir.readUInt16LE(p + 32);

      let compressedSize = dir.readUInt32LE(p + 20);
      let uncompressedSize = dir.readUInt32LE(p + 24);
      let localOffset = dir.readUInt32LE(p + 42);

      // A field set to 0xffffffff is a placeholder; the real value is in the
      // ZIP64 extra field, in a fixed order, with only the overflowing fields
      // present. Reading all four unconditionally would misalign the rest.
      const extraAt = p + 46 + nameLen;
      let e = extraAt;
      const extraEnd = extraAt + extraLen;
      while (e + 4 <= extraEnd) {
        const headerId = dir.readUInt16LE(e);
        const dataSize = dir.readUInt16LE(e + 2);
        if (headerId === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(dir.readBigUInt64LE(q));
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(dir.readBigUInt64LE(q));
            q += 8;
          }
          if (localOffset === 0xffffffff) {
            localOffset = Number(dir.readBigUInt64LE(q));
            q += 8;
          }
        }
        e += 4 + dataSize;
      }

      entries.push({
        name: dir.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
        method,
        compressedSize,
        uncompressedSize,
        localOffset,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Decode one member's bytes from the local header at `localOffset`.
 *
 * The local header repeats the name and extra field with its own lengths, which
 * is why the data offset has to be computed from the local header rather than
 * taken from the central directory.
 */
function readMember(file, size, entry) {
  const fd = openSync(file, 'r');
  try {
    // 30-byte header is an upper bound on what has to be read; a name plus extra
    // field longer than that is pathological and would be caught by the
    // signature check anyway.
    const head = Buffer.alloc(30);
    readSync(fd, head, 0, 30, entry.localOffset);
    if (head.readUInt32LE(0) !== LOC_SIG) {
      throw new Error(`bad local header for ${entry.name}`);
    }
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const dataAt = entry.localOffset + 30 + nameLen + extraLen;

    const raw = Buffer.alloc(entry.compressedSize);
    readSync(fd, raw, 0, entry.compressedSize, dataAt);

    return entry.method === 0 ? raw : inflateRawSync(raw);
  } finally {
    closeSync(fd);
  }
}

const [archive, member, outFile] = process.argv.slice(2);
if (!archive || !member || !outFile) {
  console.error('usage: node tools/extract-zip-member.mjs <archive> <member> <out-file>');
  process.exit(2);
}

const { entries, size } = readDirectory(archive);

const hits = entries.filter((e) => e.name === member || e.name.endsWith(`/${member}`));
if (hits.length === 0) {
  console.error(`no entry matching "${member}" in ${archive}`);
  console.error(`entries containing "asar" (of ${entries.length}):`);
  for (const e of entries.filter((x) => x.name.includes('asar')).slice(0, 10)) {
    console.error(`  ${e.name}`);
  }
  process.exit(1);
}
if (hits.length > 1) {
  console.error(`"${member}" is ambiguous: ${hits.map((h) => h.name).join(', ')}`);
  process.exit(1);
}

const bytes = readMember(archive, size, hits[0]);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, bytes);
console.log(`${hits[0].name} -> ${outFile}`);
console.log(`${bytes.length.toLocaleString()} bytes uncompressed`);
