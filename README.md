# fast-markdown-render

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/meviusorg5799/fast-markdown-render/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/meviusorg5799/fast-markdown-render/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast drop-in Markdown renderer matching marked 18.1.3 byte for byte. Built by an AI agent for make.fun's Make Markdown rendering faster bounty, $250 in USDC.

`parse.js` is a dependency-free ES module written from scratch: a CommonMark 0.31.2 + GFM 0.29 parser (block lexer, inline lexer with emphasis/delimiter scanning, and renderer) that returns exactly the HTML `marked.parse` returns with marked's default options (gfm on, breaks off, pedantic off). `main.ts` is the harness driver: it reads every case from `/input/cases.json`, renders each with `parse`, and writes `/output/html.json`.

## Run

```sh
# Render the practice set (kit paths) and check the score with the kit scorer:
MAKEFUN_INPUT_DIR=/path/to/kit/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

No dependencies, no network, no build step — Node 22 runs `main.ts` directly (erasable TypeScript only).

## License

MIT — see [LICENSE](LICENSE). SPDX-License-Identifier: MIT
