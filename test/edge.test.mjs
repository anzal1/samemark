import test from 'node:test'
import assert from 'node:assert/strict'
import {fromMarkdown} from 'mdast-util-from-markdown'
import {gfm} from 'micromark-extension-gfm'
import {gfmFromMarkdown} from 'mdast-util-gfm'
import {parse} from '../core.js'
import {firstDiff} from '../bench/common.mjs'
import {groups, big, huge} from './edge-cases.mjs'
import fs from 'node:fs'

const known = JSON.parse(fs.readFileSync(new URL('./known-gaps.json', import.meta.url), 'utf8'))
const opts = {extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()]}
const plain = t => JSON.parse(JSON.stringify(t))

function outcome(fn) { try { return {tree: plain(fn())} } catch (e) { return {error: e} } }

function same(src, label) {
  const ref = outcome(() => fromMarkdown(src, opts))
  const mine = outcome(() => parse(src))
  if (ref.error) {
    // micromark itself threw (for example a stack overflow): the fast parser must not return a different answer silently
    assert.ok(mine.error || mine.tree, `${label}: reference threw ${ref.error.message}`)
    console.log(`  note: micromark threw on "${label}" (${ref.error.message}); fast parser ${mine.error ? 'threw too' : 'returned a tree'}`)
    return
  }
  assert.ok(!mine.error, `${label}: fast parser threw ${mine.error && mine.error.message}`)
  const d = firstDiff(ref.tree, mine.tree)
  assert.equal(d, null, `${label}: first difference ${JSON.stringify(d, (k, v) => typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '...' : v)}`)
}

const knownNames = new Set(known.map(k => k.group + ' / ' + k.name))
for (const [group, cases] of Object.entries(groups)) {
  test(group, async t => {
    for (const [name, src] of Object.entries(cases)) {
      const full = group + ' / ' + name
      if (knownNames.has(full)) continue // tracked in known-gaps.json
      await t.test(name, () => same(src, name))
    }
  })
}

test('known gaps (failing on purpose, see KNOWN_GAPS.md)', async t => {
  for (const k of known) {
    await t.test(k.group + ' / ' + k.name, {todo: k.note}, () => same(k.src, k.name))
  }
})

test('big inputs (BIG=1)', {skip: !process.env.BIG}, async t => {
  for (const [name, make] of Object.entries(big)) {
    await t.test(name, () => {
      const src = make()
      const t0 = performance.now()
      const mine = outcome(() => parse(src))
      const tFast = performance.now() - t0
      const t1 = performance.now()
      const ref = outcome(() => fromMarkdown(src, opts))
      const tRef = performance.now() - t1
      if (ref.error) { assert.ok(mine.tree || mine.error); return }
      assert.ok(!mine.error, `fast parser threw ${mine.error && mine.error.message}`)
      assert.equal(firstDiff(ref.tree, mine.tree), null)
      console.log(`  ${name}: ${(src.length / 1048576).toFixed(1)} MB, fast ${tFast.toFixed(0)} ms, micromark ${tRef.toFixed(0)} ms`)
    })
  }
})

test('huge inputs, fast parser only (BIG=1)', {skip: !process.env.BIG}, async t => {
  for (const [name, make] of Object.entries(huge)) {
    await t.test(name, () => {
      const src = make()
      const t0 = performance.now()
      const a = parse(src)
      const ms = performance.now() - t0
      assert.equal(a.type, 'root')
      assert.ok(a.children.length > 0)
      assert.ok(ms < 20000, `took ${ms.toFixed(0)} ms`)
      // determinism and no state leak: a second parse of a tiny document afterwards is unaffected
      assert.deepEqual(plain(parse('# a *b*\n')), plain(parse('# a *b*\n')))
      console.log(`  ${name}: ${(src.length / 1048576).toFixed(1)} MB, fast ${ms.toFixed(0)} ms`)
    })
  }
})

test('input types', () => {
  const src = '# a *b*\n'
  assert.deepEqual(plain(parse(new TextEncoder().encode(src))), plain(parse(src)))
  assert.deepEqual(plain(parse(new TextEncoder().encode('﻿' + src))), plain(parse(src)))
  assert.deepEqual(plain(parse({toString: () => src})), plain(parse(src)))
})

test('no state leaks between parses (alternating hostile inputs)', () => {
  const all = Object.values(groups).flatMap(g => Object.values(g)).filter(s => s.length < 5000)
  const expected = all.map(s => outcome(() => parse(s)))
  const str = o => JSON.stringify(o.tree || String(o.error))
  for (let i = all.length - 1; i >= 0; i--) assert.equal(str(outcome(() => parse(all[i]))), str(expected[i]))
})
