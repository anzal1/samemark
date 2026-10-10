import fs from 'node:fs'
import {parse} from '../src/block.js'
const s = fs.readFileSync(process.argv[2], 'utf8')
for (const frac of [0.125, 0.25, 0.5, 1]) {
  const t = s.slice(0, Math.floor(s.length * frac))
  parse(t); parse(t)
  const a = []; for (let i = 0; i < 5; i++) { const st = process.hrtime.bigint(); parse(t); a.push(Number(process.hrtime.bigint() - st) / 1e6) }
  a.sort((x, y) => x - y)
  console.log((t.length / 1024).toFixed(0) + ' KB', a[2].toFixed(1) + ' ms')
}
