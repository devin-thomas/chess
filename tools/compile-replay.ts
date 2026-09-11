import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compileReplay } from '../replay/compiler.ts';

const [sourcePath, outputPath, manifestPath = `${outputPath}.manifest.json`] = process.argv.slice(2);
if (!sourcePath || !outputPath) {
  throw new Error('Usage: npm run compile:replay -- <source.json> <output.rply> [manifest.json]');
}

const source = readFileSync(sourcePath, 'utf8');
const compiled = compileReplay(source);
mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(outputPath, compiled.bytes);
writeFileSync(manifestPath, `${JSON.stringify(compiled.manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(compiled.manifest, null, 2)}\n`);
