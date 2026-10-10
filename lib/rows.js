// Fingerprint rows for micromark extensions and mdast-util-from-markdown extensions.
// A row names a construct or handler; it never looks at function source, so it survives minification.

function flat(list, out = []) {
  if (Array.isArray(list)) for (const x of list) flat(x, out)
  else if (list && typeof list === 'object') out.push(list)
  return out
}
export {flat}

/** rows of micromark extensions: `hook|name[|add]` per construct, `attentionMarkers|126`, `disable` rows */
export function micromarkRows(exts) {
  const rows = new Set()
  for (const ext of flat(exts)) {
    for (const hook of Object.keys(ext)) {
      const codes = ext[hook]
      if (!codes || typeof codes !== 'object') { rows.add(hook + '|?'); continue }
      if (hook === 'disable') { rows.add('disable|' + JSON.stringify(codes)); continue }
      for (const code of Object.keys(codes)) {
        const v = codes[code]
        for (const c of Array.isArray(v) ? v : [v]) {
          if (hook === 'attentionMarkers') rows.add('attentionMarkers|' + c)
          else if (c && typeof c === 'object') rows.add(typeof c.name === 'string' ? `${hook}|${c.name}${c.add ? '|' + c.add : ''}` : `${hook}|unnamed construct at code ${code}${/^\d+$/.test(code) && code > 32 && code < 127 ? ` ('${String.fromCharCode(code)}')` : ''}`)
          else rows.add(`${hook}|?`)
        }
      }
    }
  }
  return [...rows].sort()
}

/** rows of from-markdown extensions: `enter|x`, `exit|x`, `canContainEols|x`, `transforms|n`, other keys by name */
export function mdastRows(exts) {
  const rows = new Set()
  let transforms = 0
  for (const ext of flat(exts)) {
    for (const key of Object.keys(ext)) {
      const v = ext[key]
      if (key === 'enter' || key === 'exit') { for (const k of Object.keys(v || {})) rows.add(`${key}|${k}`) }
      else if (key === 'canContainEols') { for (const k of [].concat(v)) rows.add(`canContainEols|${k}`) }
      else if (key === 'transforms') transforms += Array.isArray(v) ? v.length : 1
      else rows.add(`${key}|?`)
    }
  }
  if (transforms) rows.add('transforms|' + transforms)
  return [...rows].sort()
}
