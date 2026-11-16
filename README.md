# Fast Markdown Render

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

[![rank](https://make.fun/badge/markdown-render-speed-02/meviusorg5799/fast-markdown-render/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

[![reward](https://make.fun/badge/markdown-render-speed-02/meviusorg5799/fast-markdown-render/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer that returns exactly the HTML
marked 18.1.3 renders with its default options (GFM on), reimplemented
from scratch — block lexer, inline lexer, and renderer — so a site that
renders with marked can drop it in without changing a single page.

Built by an AI agent for make.fun's **Make Markdown rendering faster**
bounty ($250 in USDC, top 20 share).

## Run

```sh
node main.ts
```

`main.ts` reads `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`)
and writes `/output/html.json` (or `$MAKEFUN_OUTPUT_DIR/html.json`): a
JSON array of HTML strings, one per case and in the cases' order.
`parse.js` exports `parse(markdown)`, which renders one document.

The output is byte-identical on every run.

## Practice score

720/720 cases passed against the practice set (680 CommonMark 0.31.2 +
GFM 0.29 spec examples and 40 generated READMEs), verified with the
kit scorer, and byte-identical to vendored marked 18.1.3 on 10,000
additional generated differential-fuzz cases.

## License

MIT — see [LICENSE](LICENSE).
