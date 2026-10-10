// Reference parsers (mdast-util-from-markdown + micromark) for the optional extension sets.
import {fromMarkdown} from 'mdast-util-from-markdown'
import {gfm} from 'micromark-extension-gfm'
import {gfmFromMarkdown} from 'mdast-util-gfm'
import {frontmatter} from 'micromark-extension-frontmatter'
import {frontmatterFromMarkdown} from 'mdast-util-frontmatter'

export function refFrontmatter(matters) {
  const opts = {extensions: [gfm(), frontmatter(matters)], mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(matters)]}
  return src => fromMarkdown(src, opts)
}

import {math} from 'micromark-extension-math'
import {mathFromMarkdown} from 'mdast-util-math'
export function refMath(options) {
  const opts = {extensions: [gfm(), math(options)], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()]}
  return src => fromMarkdown(src, opts)
}
// any mix of the optional extensions
export function refAll(matters, mathOptions, withFm, withMath) {
  const extensions = [gfm()], mdastExtensions = [gfmFromMarkdown()]
  if (withFm) { extensions.push(frontmatter(matters)); mdastExtensions.push(frontmatterFromMarkdown(matters)) }
  if (withMath) { extensions.push(math(mathOptions)); mdastExtensions.push(mathFromMarkdown()) }
  const opts = {extensions, mdastExtensions}
  return src => fromMarkdown(src, opts)
}
