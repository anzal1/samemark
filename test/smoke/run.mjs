// Runs unchanged on Node, Deno and Bun: prints a JSON digest of a few parses. CI diffs the digests across runtimes.
import {parse, stats, check} from '../../core.js'

const docs = [
  '# Title\n\nSome *emphasis*, **strong**, `code`, a [link](http://a.b "t") and ![img](i.png).\n\n- one\n- [x] two ~~old~~\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nwww.example.com and foo@bar.baz[^1]\n\n[^1]: note\n',
  '[a]: /u&amp;x "&ouml;&#x41;&copy;"\n\n[A] [b][a]\r\n\r\n```js &amp;\r\ncode\r\n```\r\n',
  '﻿a\0b\n\n\ud800 *😀*\n',
  ''
]
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0).toString(16) }
const out = docs.map(d => { const json = JSON.stringify(parse(d)); return {len: json.length, hash: hash(json)} })
console.log(JSON.stringify({out, fast: stats.fast, check: check([], [])}))
