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
      <BrandWordmark size={22} />
      <p className={`maestro-login-copy${error ? ' maestro-login-error' : ''}`}>
        {error ? 'Wrong PIN, try again.' : 'This public address is PIN-protected.'}
      </p>
      <span className="maestro-login-input">
        <Input name="token" inputMode="numeric" maxLength={8} autoFocus required aria-label="Access PIN" placeholder="8-digit PIN" />
      </span>
      <Button variant="primary" type="submit">Enter</Button>
    </form>
  )
}

createRoot(document.getElementById('maestro-login-root')).render(h(LoginCard))
