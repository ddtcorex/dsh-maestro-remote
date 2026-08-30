export function installAppleIcon(): (() => void) | void {
  if (document.querySelector('link[rel="apple-touch-icon"]')) return
  const link = document.createElement('link')
  link.rel = 'apple-touch-icon'
  link.href = '/apple-touch-icon.png'
  document.head.appendChild(link)
  return () => link.remove()
}
