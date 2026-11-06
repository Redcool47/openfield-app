import { readFileSync, writeFileSync } from 'node:fs';

const f = process.argv[2];
let t = readFileSync(f, 'utf8');

t = t.replace(/const db = new DatabaseForTest\(\);/g, 'const db = await newOpen();');

// Any test body that now contains `await` must be an async callback.
t = t.replace(/it\((['"][^'"]*['"]), \(\) => \{(\n\s*const db = await newOpen\(\);)/g, (m, name, tail) =>
  `it(${name}, async () => {${tail}`);

t = t.replace(
  /\n\/\*\* Isolated in-memory repository[\s\S]*$/,
  `
/** Isolated in-memory repository so each test starts clean. */
async function newOpen(): Promise<{ repo: Repository; close(): void }> {
  const repo = await Repository.memory();
  return { repo, close: () => repo.close() };
}
void indent;
`,
);

writeFileSync(f, t);
console.log('patched; remaining sync ctor uses:', (t.match(/new DatabaseForTest/g) ?? []).length);