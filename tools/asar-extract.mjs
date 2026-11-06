#!/usr/bin/env node
// Minimal ASAR reader used only to unpack an analysis input for local greppable
// inspection. The ASAR container format is a documented simple layout:
//   uint32 LE header-pickle size, uint32 LE header pickle payload size,
//   uint32 LE header JSON byte length (twice), UTF-8 JSON header, then payloads
//   concatenated in header order.
// REA remains the sanctioned analyzer; this is a file-format decode, not analysis.
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [archivePath, outDir] = process.argv.slice(2);
if (!archivePath || !outDir) {
  console.error('usage: asar-extract.mjs <archive.asar> <outDir>');
  process.exit(2);
}

const buf = readFileSync(archivePath);
const sizePickle = buf.readUInt32LE(0);
const headerSize = buf.readUInt32LE(4);
const headerJsonSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.toString('utf8', 16, 16 + headerJsonSize));
const dataStart = 8 + sizePickle + headerSize;

let files = 0;
let bytes = 0;

function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (entry.files) {
      walk(entry, rel);
      continue;
    }
    if (entry.unpacked) continue;
    const start = dataStart + Number(entry.offset);
    const dest = join(outDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf.subarray(start, start + entry.size));
    files += 1;
    bytes += entry.size;
  }
}

walk(header, '');

const companion = `${archivePath}.unpacked`;
if (existsSync(companion)) {
  cpSync(companion, join(outDir, '_companion'), { recursive: true });
}

console.log(`extracted ${files} files, ${bytes} bytes -> ${resolve(outDir)}`);