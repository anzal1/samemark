# Changelog

## 0.1.0 (2026-10-10)

First release.

- `samemark`: `parse()` and the `remarkParseFast` unified plugin, same mdast as `mdast-util-from-markdown` with GFM,
  frontmatter and math supported natively, fallback to the real parser for anything else.
- `samemark/core`: the same without the fallback import.
- `samemark/stream`: incremental parser for streamed text (LLM chat UIs); after every chunk the tree equals a full parse.

Matches mdast-util-from-markdown 2.1.0 + micromark-extension-gfm 3.0.0 + mdast-util-gfm 3.1.0 (plus
micromark-extension-frontmatter and micromark-extension-math for those plugins). Known gaps: KNOWN_GAPS.md.
