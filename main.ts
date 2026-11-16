import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";

type Case = { id: string; markdown: string };

const cases = JSON.parse(
  readFileSync(`${inputDir}/cases.json`, "utf8")
) as Case[];
const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(`${outputDir}/html.json`, JSON.stringify(html));
