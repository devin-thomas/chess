import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compileReplay } from '../replay/compiler.ts';

const [sourcePath = 'shared/replay-fixtures/castle-kingside.json', outputPath = 'build/nes_replay_data.h'] = process.argv.slice(2);
const compiled = compileReplay(readFileSync(sourcePath, 'utf8'));
const values: string[] = [];
for (let index = 0; index < compiled.bytes.length; index += 12) {
  values.push(`  ${Array.from(compiled.bytes.slice(index, index + 12), value => `0x${value.toString(16).padStart(2, '0')}`).join(', ')}`);
}
const header = `#ifndef NES_REPLAY_DATA_H\n#define NES_REPLAY_DATA_H\n\n#define NES_REPLAY_DATA_LEN ${compiled.bytes.length}U\nstatic const unsigned char NES_REPLAY_DATA[] = {\n${values.join(',\n')}\n};\n\n#endif\n`;
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, header, 'utf8');
process.stdout.write(`${JSON.stringify(compiled.manifest)}\n`);
