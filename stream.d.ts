import type {Root} from 'mdast'

export interface StreamOptions {
  /**
   * Parse a leading frontmatter block like `remark-frontmatter` does: `true` (yaml), `'yaml'`, `'toml'`, an object
   * with `type` and `marker` or `fence`, or an array of those. `anywhere: true` matters are not supported.
   */
  frontmatter?: boolean | string | Record<string, unknown> | Array<string | Record<string, unknown>> | null | undefined
  /** Parse `$` and `$$` math like `remark-math`: `true` or `{single: false}` for `singleDollarTextMath: false`. */
  math?: boolean | {single?: boolean} | null | undefined
}

export interface StreamParser {
  /** Append text and return the tree for everything pushed so far, equal to a full parse of the concatenation. */
  push(chunk: string): Root
  /** The tree for everything pushed so far (same as the last `push`). Call it when the stream is finished. */
  end(): Root
  /** Forget everything and start a new message. */
  reset(): void
}

/**
 * Create an incremental parser. Top-level blocks that can no longer change keep their object identity between pushes
 * (stable keys for `React.memo`); only the unfinished tail is parsed again.
 */
export function createStreamParser(options?: StreamOptions | null): StreamParser
