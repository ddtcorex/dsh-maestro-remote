export function installViewportPatch(): (() => void) | void {
  const meta = document.querySelector('meta[name="viewport"]') as HTMLMetaElement | null
  if (!meta) return
  const cur = meta.getAttribute('content') ?? ''
  if (cur.includes('maximum-scale')) return
  const prev = cur
  const next = cur.replace(/,\s*$/, '') + ', maximum-scale=1'
  meta.setAttribute('content', next)
  return () => meta.setAttribute('content', prev)
}
