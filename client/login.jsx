import { createElement as h, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives/src/Input.tsx'
import { BrandWordmark } from '@deepseek-ai/dsh-client-ui-primitives/src/BrandWordmark.tsx'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/base.css'
import '@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css'
import './login-extras.css'

function LoginCard() {
  const error = window.__MAESTRO_LOGIN_ERROR__ === true

  useEffect(() => {
    document.querySelector('[data-maestro-login-fallback]')?.remove()
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.body.toggleAttribute('data-ds-dark-theme', dark.matches) }
    apply()
    dark.addEventListener('change', apply)
    return () => { dark.removeEventListener('change', apply) }
  }, [])

  return (
    <form method="post" action="/maestro-login" className={`maestro-login-card${error ? ' maestro-shake' : ''}`}>
      <span className="maestro-login-badge" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M2 11 L5 4 L8 9 L11 4 L14 11" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <div className="maestro-login-head">
        <h1 className="maestro-login-title">Maestro access</h1>
        <p className={`maestro-login-copy${error ? ' maestro-login-error' : ''}`}>
          {error ? 'Wrong PIN, try again.' : 'This public address is PIN-protected.'}
        </p>
      </div>
      <span className="maestro-login-input">
        <Input name="pin" inputMode="numeric" maxLength={8} autoFocus required aria-label="Access PIN" placeholder="••••••••" autoComplete="one-time-code" />
      </span>
      <Button variant="primary" type="submit" className="maestro-login-btn">Enter</Button>
      <p className="maestro-login-foot">PIN from Maestro Settings → Tunnel · rotates on demand</p>
    </form>
  )
}

createRoot(document.getElementById('maestro-login-root')).render(h(LoginCard))
