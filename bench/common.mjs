import {fromMarkdown} from 'mdast-util-from-markdown'
import {gfm} from 'micromark-extension-gfm'
import {gfmFromMarkdown} from 'mdast-util-gfm'

const opts = {extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()]}
export function ref(src) { return fromMarkdown(src, opts) }

const PHR = new Set(['paragraph', 'heading', 'tableCell'])
// strip children of phrasing containers, in place
export function strip(node) {
  if (PHR.has(node.type)) { node.children = []; return node }
  const ch = node.children
  if (ch) for (let i = 0; i < ch.length; i++) strip(ch[i])
  return node
}

// first difference path between two json-ish values
export function firstDiff(a, b, path = '') {
  if (a === b) return null
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return {path, a, b}
  if (Array.isArray(a) !== Array.isArray(b)) return {path, a, b}
  if (Array.isArray(a)) {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (i >= a.length || i >= b.length) return {path: path + '[' + i + ']', a: a[i], b: b[i], lenA: a.length, lenB: b.length}
      const d = firstDiff(a[i], b[i], path + '[' + i + ']')
      if (d) return d
    }
    return null
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], path + '.' + k)
    if (d) return d
  }
  return null
}
