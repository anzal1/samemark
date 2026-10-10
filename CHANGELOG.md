# Changelog

## Unreleased (0.0.0)

First version. Nothing is published yet.

- `samemark`: `parse()` and the `remarkParseFast` unified plugin, same mdast as `mdast-util-from-markdown` with GFM,
  frontmatter and math supported natively, fallback to the real parser for anything else.
- `samemark/core`: the same without the fallback import.
- `samemark/stream`: incremental parser for streamed text (LLM chat UIs).
