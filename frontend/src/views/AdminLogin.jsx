/* Login dedicado do painel — usuário e senha do administrador (nada de passkey:
   as credenciais do gestor ficam em db.admins, hash scrypt, fora dos perfis).  */
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

export default function AdminLogin({ onOk, onHome }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])

  const go = async e => {
    if (e) e.preventDefault()
    setBusy(true); setErr(null)
    try {
      await api('/api/panel/login', { method: 'POST', body: JSON.stringify({ username, password }) })
      onOk()
    } catch (ex) { setErr(ex.message || 'Falha no login') }
    finally { setBusy(false) }
  }

  return (
    <div className="pa-page">
      <button className="pa-back" onClick={onHome}>← Voltar para o início</button>
      <form className="pa-card" onSubmit={go}>
        <div className="pa-logo"><Icon name="shield" /></div>
        <h1>Administração</h1>
        <p className="pa-tag">Painel restrito — acesso separado do aplicativo.</p>
        <input
          ref={ref} className="input" placeholder="Usuário administrador" autoComplete="username"
          value={username} onChange={e => setUsername(e.target.value)}
        />
        <div style={{ height: 10 }} />
        <input
          className="input" type="password" placeholder="Senha" autoComplete="current-password"
          value={password} onChange={e => setPassword(e.target.value)}
        />
        {err && <div className="pa-err">{err}</div>}
        <div style={{ height: 14 }} />
        <Button variant="primary" size="lg" icon="key" type="submit" disabled={busy || !username || !password}>
          {busy ? 'Verificando…' : 'Entrar no painel'}
        </Button>
        <p className="pa-foot">As credenciais do painel são definidas no servidor (ADMIN_USERNAME / ADMIN_PASSWORD).</p>
      </form>
    </div>
  )
}
