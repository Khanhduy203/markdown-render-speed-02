# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Khanhduy203/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Khanhduy203/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

Entry for the [make.fun markdown-render-speed-02 bounty](https://make.fun/bounty/markdown-render-speed-02).

A dependency-free, fast reimplementation of marked 18.1.3's HTML output
(default options, GFM on), written from the CommonMark and GFM specs plus
black-box probing of marked's exact edge-case behavior.

## Layout

- `parse.js` — the parser. `parse(markdown)` returns exactly the HTML string
  marked 18.1.3's `marked.parse(markdown)` returns with default options.
  ES module, no dependencies.
- `main.ts` — the harness driver: reads `/input/cases.json`, renders each case
  alone with `parse`, writes `/output/html.json`.

## Design

Two-phase: a block parser builds a block tree (collecting link reference
definitions first, since they may be defined after their use), then a render
walk emits HTML, parsing inline content with a delimiter-stack emphasis
algorithm. Marked's quirks are reproduced deliberately, including:

- newlines preserved literally in paragraph text (no soft-break-to-space),
- all five characters escaped in text and code (`& < > " '`),
- named entities passed through verbatim, numeric references decoded with
  marked's digit limits (decimal ≤ 7, hex ≤ 6) and no Windows-1252 remapping,
- `~` strikethrough that is not GFM-spec (single `~` opens, runs of length
  ≥ 3 never open or close, closer must match the opener's length),
- no URL scheme sanitizing; hrefs are `encodeURI` plus bare-`&` escaping,
- tables whose delimiter row must match the header cell count, with marked's
  exact `<tbody>` layout, and HTML blocks whose trailing newline appears only
  at end of input.

## Testing

Against the kit's 720-case practice set (680 CommonMark/GFM spec examples
plus 40 generated documents), the output is byte-identical to marked 18.1.3.
