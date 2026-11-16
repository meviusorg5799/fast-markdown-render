// Driver for the fast Markdown renderer: reads /input/cases.json and
// writes /output/html.json (or the MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR
// overrides when they are set). Plain erasable TypeScript only.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  markdown: string;
}[];

const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));

mkdirSync(OUTPUT_DIR, { recursive: true });
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
