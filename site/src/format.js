// time formatting shared by both demos
export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '-'
  if (ms >= 1000) return (ms / 1000).toFixed(2) + ' s'
  if (ms >= 10) return Math.round(ms) + ' ms'
  if (ms >= 1) return ms.toFixed(1) + ' ms'
  if (ms >= 0.01) return ms.toFixed(2) + ' ms'
  return '<0.01 ms'
}
