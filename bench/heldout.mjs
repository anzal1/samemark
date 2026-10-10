// Held-out check on markdown files you point it at (a machine specific set: the author ran it on the non-README
// markdown files of one development machine, which cannot be published; this script lets anyone repeat that on theirs).
//   node bench/heldout.mjs --roots=dir1,dir2 [--list=files.txt] [--from=0 --to=1000]   (list = one path per line, written on first use)
// Prints identity and every mismatching file (first differing path) so each miss can be reduced to a minimal repro.
import {execSync} from 'node:child_process'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {ref, firstDiff} from './common.mjs'
import {parse} from '../src/block.js'
const arg = k => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').slice(k.length + 3)
const listFile = arg('list')
const roots = arg('roots').split(',').filter(Boolean)
if (!roots.length && !(listFile && fs.existsSync(listFile))) {
  console.error('usage: node bench/heldout.mjs --roots=dir1,dir2 [--list=files.txt] [--from=0 --to=1000]\n  --roots: directories searched for *.md / *.markdown files (README.md files are skipped)')
  process.exit(2)
}
let out
if (listFile && fs.existsSync(listFile)) out = fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean)
else {
  const raw = execSync(`find ${roots.map(r => JSON.stringify(r)).join(' ')} -type f \\( -iname '*.md' -o -iname '*.markdown' \\) -not -iname readme.md -not -path '*/node_modules/*' -size -400k 2>/dev/null | head -50000`, {maxBuffer: 1 << 28}).toString().split('\n').filter(Boolean)
  const seenH = new Set(); out = []
  for (const f of raw) {
    let s; try { s = fs.readFileSync(f, 'utf8') } catch { continue }
    const h = crypto.createHash('sha1').update(s).digest('hex').slice(0, 12)
    if (seenH.has(h)) continue
    seenH.add(h); out.push(f)
  }
  if (listFile) fs.writeFileSync(listFile, out.join('\n') + '\n')
}
const from = Number(arg('from') || 0), to = Number(arg('to') || out.length)
let n = 0, ok = 0, bytes = 0, crashes = 0
const bad = []
for (const f of out.slice(from, to)) {
  let s; try { s = fs.readFileSync(f, 'utf8') } catch { continue }
  n++; bytes += s.length
  let ra; try { ra = ref(s) } catch { n--; continue }
  let mb; try { mb = parse(s) } catch (e) { crashes++; bad.push(f + '  CRASH ' + e.message); continue }
  const d = firstDiff(JSON.parse(JSON.stringify(ra)), JSON.parse(JSON.stringify(mb)))
  if (!d) { ok++; continue }
  bad.push(f + '  ' + d.path)
}
console.log(`heldout [${from}, ${Math.min(to, out.length)}) of ${out.length}: ${n} files ${(bytes / 1e6).toFixed(1)} MB, identical ${ok} = ${(100 * ok / Math.max(n, 1)).toFixed(2)}%, crashes ${crashes}`)
for (const b of bad) console.log('  MISS ' + b)
