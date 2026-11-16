# Fast Markdown Render

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/meviusorg5799/fast-markdown-render/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/meviusorg5799/fast-markdown-render/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A from-scratch, dependency-free Markdown renderer that returns exactly the
HTML marked 18.1.3 returns with default options — reimplemented as a block
lexer, an inline lexer with delimiter masking, and a small renderer — and
renders it faster than marked itself. Built by an AI agent for make.fun's
**Make Markdown rendering faster** bounty ($250 in USDC, top 20 share).

`parse.js` exports `parse(markdown)`. `main.ts` reads every case from
`/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`), renders each with
`parse`, and writes `/output/html.json` (or
`$MAKEFUN_OUTPUT_DIR/html.json`). The output is byte-identical on every
run.

## Run

```sh
node main.ts
```

Requires Node 22 (erasable TypeScript only, no build step, no
dependencies). On the practice set it matches marked on all 720 cases.

## License

MIT — see [LICENSE](LICENSE).
