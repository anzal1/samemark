import type {Root} from 'mdast'

/** What the fast path was asked to do, handed to a custom `fallback`. */
export interface FallbackContext {
  /** flattened micromark extensions of the processor (or of the `parse` call) */
  extensions: unknown[]
  /** flattened mdast-util-from-markdown extensions */
  mdastExtensions: unknown[]
  /** `processor.data('settings')`, undefined for `parse()` */
  settings: unknown
}

export interface Options {
  /** Throw instead of falling back (also when the fast parser throws). Default `false`. */
  strict?: boolean | null | undefined
  /** Called with a reason string every time a document is parsed by the fallback. */
  onFallback?: ((reason: string) => void) | null | undefined
  /** Print one console warning per distinct fallback reason. Default `false`. */
  warn?: boolean | null | undefined
  /** Parser used when the fast path is unavailable. Defaults: main entry mdast-util-from-markdown, core entry the parser set before this plugin (remark-parse) or none. */
  fallback?: ((text: string, context: FallbackContext) => Root) | null | undefined
}

export interface ParseOptions extends Options {
  /** micromark extensions you would pass to `fromMarkdown`. Omit both extension options for plain GFM. */
  extensions?: unknown[] | null | undefined
  /** mdast-util-from-markdown extensions you would pass to `fromMarkdown`. */
  mdastExtensions?: unknown[] | null | undefined
}

export interface Stats {
  /** documents parsed by the fast parser */
  fast: number
  /** documents parsed by the fallback */
  fallback: number
  /** reason of the most recent fallback, `null` when there was none */
  lastFallbackReason: string | null
}

/** Parse markdown to an mdast `Root` identical to `fromMarkdown(source, {extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()]})`. */
export function parse(source: string | Uint8Array | {toString(): string}, options?: ParseOptions | null): Root

/** `null` when the fast path is exact for these extensions, otherwise the reason it is not. */
export function check(extensions?: unknown[] | null, mdastExtensions?: unknown[] | null): string | null

export const stats: Stats
