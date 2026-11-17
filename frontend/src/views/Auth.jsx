/* Página de autenticação de usuários (server flavor) — dedicada, fora do app.
   Passkey para entrar; criação de perfil com nome (+ convite quando o servidor
   exige). O modo convidado não existe aqui de propósito: o serviço é assinado.
   Em builds MOBILE/DEMO o app continua usando a Login.jsx clássica.             */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore, hasData } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { webauthnOK, passkeyLogin, passkeyRegister, api, IS_APPLE, IS_ANDROID } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import '../styles/auth.css'

export default function Auth() {
  const navigate = useNavigate()
  const { setUser, pushState, pullState, config } = useStore()
  // BIO do lib/api.js é inglês por userAgent — aqui a página é PT-BR de propósito.
  const bio = IS_APPLE ? 'Face ID ou Touch ID' : IS_ANDROID ? 'impressão digital ou desbloqueio facial' : 'impressão digital, rosto ou PIN'
  const [mode, setMode] = useState('in')            // 'in' | 'up'
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [inviteOnly, setInviteOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [brand, setBrand] = useState('openGym')
  const ref = useRef(null)
  const toast = m => useUI.getState().toast(m)

  useEffect(() => {
    api('/api/config').then(c => {
      setInviteOnly(!!c.invite_only)
      if (c.brand) setBrand(c.brand)
    }).catch(() => {})
  }, [])
  useEffect(() => { if (mode === 'up') setTimeout(() => ref.current?.focus(), 250) }, [mode])

  const afterAuth = async (u, created) => {
    setUser(u)
    // O gate de assinatura lê o billing do store, não de user.billing — grava aqui para a
    // decisão (entrar no app ou mostrar /billing) valer imediatamente, sem recarregar.
    useStore.setState({ billing: u.billing || null })
    if (created && hasData(useStore.getState().S)) {
      await pushState(); toast('Perfil criado — dados deste dispositivo movidos para ele')
    } else { await pullState() }
    navigate('/home', { replace: true })
  }

  const signIn = async () => {
    setBusy(true)
    try { await afterAuth(await passkeyLogin(), false) }
    catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast(e.message || 'Não foi possível entrar') }
    finally { setBusy(false) }
  }

  const signUp = async () => {
    const n = name.trim()
    if (!n) { toast('Digite seu nome'); return }
    if (inviteOnly && !code.trim()) { toast('É necessário um código de convite'); return }
    setBusy(true)
    try {
      const u = await passkeyRegister(n, code.trim())
      await afterAuth(u, true)
      toast(`Bem-vindo(a), ${u.name}!`)
    } catch (e) {
      if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast(e.message || 'Falha ao criar o perfil')
    } finally { setBusy(false) }
  }

  return (
    <div className="au-page">
      <button className="au-back" onClick={() => navigate('/')}>
        <Icon name="play" style={{ transform: 'rotate(180deg)' }} /> Voltar para o início
      </button>

      <div className="au-card">
        <div className="au-logo"><Icon name="dumbbell" /></div>
        <h1>{brand}</h1>
        <p className="au-tag">Seu treino. Seus pesos. Seus dados.</p>

        {mode === 'in' ? (
          <>
            {webauthnOK() ? (
              <>
                <Button variant="primary" size="lg" icon="person" disabled={busy} onClick={signIn}>
                  Entrar com passkey
                </Button>
                <div className="au-sep"><span>ou</span></div>
                <Button size="lg" icon="sparkles" disabled={busy} onClick={() => setMode('up')}>
                  Criar um perfil novo
                </Button>
              </>
            ) : (
              <div className="au-note">Este navegador não suporta passkeys — abra em um navegador recente ou use o aplicativo instalado.</div>
            )}
            <p className="au-foot">
              Passkey usa {bio} — sem senhas.<br />Cada perfil mantém planilha, treinos e peso separados.
            </p>
          </>
        ) : (
          <>
            <div className="au-form">
              <input
                ref={ref} className="input" placeholder="Seu nome" maxLength={40}
                value={name} onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') signUp() }}
              />
              {inviteOnly && (
                <>
                  <div style={{ height: 10 }} />
                  <input
                    className="input" placeholder="Código de convite" maxLength={40}
                    value={code} onChange={e => setCode(e.target.value.toUpperCase())}
                    style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }}
                  />
                  <div className="au-hint">Este serviço é somente por convite — use o código que você recebeu.</div>
                </>
              )}
              <div style={{ height: 12 }} />
              <Button variant="primary" size="lg" icon="key" disabled={busy} onClick={signUp}>
                Criar passkey e começar
              </Button>
            </div>
            <button className="au-toggle" onClick={() => setMode('in')}>Já tenho perfil — entrar</button>
            <p className="au-foot">Você começa com o período de avaliação grátis. Depois, assinatura mensal — cancele quando quiser.</p>
          </>
        )}
      </div>

      <div className="au-bottom lg-dim" style={{ color: 'var(--label-3)' }}>
        Ao continuar você concorda que seus dados de treino ficam guardados neste serviço, vinculados apenas ao seu perfil.
      </div>
    </div>
  )
}
