/* Painel de administração — CRUD completo de usuários e gestão da aplicação:
   visão geral, usuários (CRUD total), pagamentos (filtros/CSV), convites,
   configurações (preço/trial/pix/métodos editáveis no ar) e manutenção
   (broadcast push, tick, backup). Tudo PT-BR, tudo via /api/panel/*.   */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import AdminUsers from './AdminUsers.jsx'
import AdminPayments from './AdminPayments.jsx'
import { STATUS, fmtBRL, fmtDate } from './adminUtils.js'

const TABS = [
  { id: 'visao', label: 'Visão geral', icon: 'chart' },
  { id: 'users', label: 'Usuários', icon: 'person' },
  { id: 'payments', label: 'Pagamentos', icon: 'clipboard' },
  { id: 'invites', label: 'Convites', icon: 'key' },
  { id: 'settings', label: 'Configurações', icon: 'gear' },
  { id: 'maint', label: 'Manutenção', icon: 'wrench' }
]

function Stat({ label, value, tone }) {
  return (
    <div className={`pa-stat${tone ? ' ' + tone : ''}`}>
      <div className="pa-stat-v">{value}</div>
      <div className="pa-stat-l">{label}</div>
    </div>
  )
}

function Dot({ ok }) {
  return <span className={`pa-dot ${ok ? 'ok' : 'no'}`} />
}

/* ------------------------- aba: visão geral ------------------------- */
function Overview({ ov, users, payments, busy, act, go }) {
  const pend = payments.filter(p => p.status === 'pending').slice(0, 6)
  const integ = ov.integration || {}
  return (
    <>
      <div className="pa-stats">
        <Stat label="Usuários" value={ov.users} />
        <Stat label="Assinaturas ativas" value={ov.by.active} tone="ok" />
        <Stat label="Em trial" value={ov.by.trial} tone="warn" />
        <Stat label="Isentos" value={ov.by.free} />
        <Stat label="Vencidos" value={ov.by.overdue} tone="bad" />
        <Stat label="Desativados" value={ov.disabled} />
        <Stat label="Novos (7d)" value={ov.newUsers7} />
        <Stat label="Novos (30d)" value={ov.newUsers30} />
        <Stat label={`MRR (${fmtBRL(ov.price)}/mês)`} value={fmtBRL(ov.mrr)} tone="ok" />
        <Stat label="Recebido (30d)" value={fmtBRL(ov.revenue30)} tone="ok" />
        <Stat label="Receita total" value={fmtBRL(ov.revenueTotal)} />
        <Stat label="Cobranças pendentes" value={ov.pendingPayments} tone={ov.pendingPayments ? 'warn' : ''} />
      </div>

      <div className="pa-grid-2">
        <div className="pa-box">
          <h3 className="pa-sec" style={{ marginTop: 0 }}>Meios de pagamento</h3>
          <div className="pa-kv">
            <div><Dot ok={integ.cakto} /> Cakto (API pública)</div>
            <div><Dot ok={integ.webhookSecret} /> Webhook assinado (HMAC)</div>
            <div><Dot ok={ov.methods?.pix} /> Pix na hora (QR no app)</div>
            <div><Dot ok={ov.methods?.checkout} /> Checkout Cakto — cartão, PicPay, Google Pay, Apple Pay</div>
            <div><Dot ok={integ.pixKey} /> Chave Pix manual (fallback)</div>
          </div>
          {integ.offerId && <div className="pa-item-meta">Oferta: <code>{integ.offerId}</code>{integ.hostedUrl && <> · checkout: <a href={integ.hostedUrl} target="_blank" rel="noreferrer">{integ.hostedUrl}</a></>}</div>}
        </div>

        <div className="pa-box">
          <h3 className="pa-sec" style={{ marginTop: 0 }}>Aprovações aguardando</h3>
          {pend.length ? pend.map(p => (
            <div className="pa-mini-row" key={p.id}>
              <div className="pa-item-main">
                <div className="pa-item-name">{p.userName} <span className="pa-dim">{fmtBRL(p.amount)}</span></div>
                <div className="pa-item-meta">{fmtDate(p.createdAt)} · {p.method === 'pix' ? 'Pix manual' : p.method}</div>
              </div>
              <Button size="sm" variant="primary" icon="check" disabled={busy}
                onClick={() => act('/api/panel/payment/approve', { id: p.id }, 'Pagamento aprovado — acesso liberado')}>
                Aprovar
              </Button>
            </div>
          )) : <div className="pa-dim">Nada pendente — tudo em dia.</div>}
          {payments.length > pend.length && <button className="pa-link" onClick={() => go('payments')}>ver todos os pagamentos →</button>}
        </div>
      </div>
    </>
  )
}

/* ------------------------ aba: configurações ------------------------ */
function SettingsTab({ onSaved }) {
  const [s, setS] = useState(null)
  const [integ, setInteg] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  const load = useCallback(async () => {
    try {
      const r = await api('/api/panel/settings')
      setS({ ...r.settings, methods: { ...r.settings.methods }, inviteOnly: !!r.inviteOnly })
      setInteg(r.integration)
    } catch (e) { setMsg({ err: e.message }) }
  }, [])
  useEffect(() => { load() }, [load])

  if (!s) return <div className="pa-empty">{msg?.err || 'Carregando…'}</div>
  const set = (k, v) => setS(cur => ({ ...cur, [k]: v }))

  const save = async () => {
    setBusy(true); setMsg(null)
    try {
      const body = {
        brand: s.brand, price: +s.price, currency: s.currency,
        trialDays: +s.trialDays, periodDays: +s.periodDays,
        pixKey: s.pixKey, pixHolder: s.pixHolder,
        methods: s.methods, inviteOnly: !!s.inviteOnly
      }
      const r = await api('/api/panel/settings', { method: 'POST', body: JSON.stringify(body) })
      setS({ ...r.settings, methods: { ...r.settings.methods }, inviteOnly: !!r.inviteOnly })
      setMsg({ ok: 'Configurações salvas — aplicadas na hora para todos os usuários.' })
      onSaved?.()
    } catch (e) { setMsg({ err: e.message }) }
    finally { setBusy(false) }
  }

  return (
    <div className="pa-box pa-form-card">
      <h3 className="pa-sec" style={{ marginTop: 0 }}>Marca e preço</h3>
      <div className="pa-form-grid">
        <label className="pa-field"><span>Nome do app</span>
          <input className="input" value={s.brand} maxLength={40} onChange={e => set('brand', e.target.value)} /></label>
        <label className="pa-field"><span>Preço mensal</span>
          <input className="input" type="number" step="0.01" min="0.01" value={s.price} onChange={e => set('price', e.target.value)} /></label>
        <label className="pa-field"><span>Moeda</span>
          <input className="input" value={s.currency} maxLength={3} onChange={e => set('currency', e.target.value.toUpperCase())} /></label>
        <label className="pa-field"><span>Dias de trial</span>
          <input className="input" type="number" min="0" max="365" value={s.trialDays} onChange={e => set('trialDays', e.target.value)} /></label>
        <label className="pa-field"><span>Dias por período pago</span>
          <input className="input" type="number" min="1" max="3650" value={s.periodDays} onChange={e => set('periodDays', e.target.value)} /></label>
      </div>

      <h3 className="pa-sec">Meios de pagamento disponíveis no app</h3>
      <div className="pa-check-row">
        <label className="pa-check"><input type="checkbox" checked={!!s.methods.pix} onChange={e => set('methods', { ...s.methods, pix: e.target.checked })} />
          Pix na hora (QR gerado no app, aprovação automática)</label>
        <label className="pa-check"><input type="checkbox" checked={!!s.methods.checkout} onChange={e => set('methods', { ...s.methods, checkout: e.target.checked })} />
          Checkout Cakto (cartão de crédito, PicPay, Google Pay, Apple Pay)</label>
      </div>
      {integ && !integ.cakto && <div className="pa-warn-box">As credenciais do Cakto não estão no ambiente (CAKTO_CLIENT_ID / SECRET / OFFER_ID) — com Cakto desligado o app usa chave Pix manual ou Mercado Pago.</div>}
      <div className="pa-item-meta">
        Preço cobrado pela oferta do Cakto: configure lá no painel da Cakto para o mesmo valor. {integ?.hostedUrl && <>Checkout: <a href={integ.hostedUrl} target="_blank" rel="noreferrer">{integ.hostedUrl}</a></>}
      </div>

      <h3 className="pa-sec">Chave Pix manual (fallback, opcional)</h3>
      <div className="pa-form-grid">
        <label className="pa-field"><span>Chave Pix</span>
          <input className="input" value={s.pixKey || ''} maxLength={120} onChange={e => set('pixKey', e.target.value)} /></label>
        <label className="pa-field"><span>Titular</span>
          <input className="input" value={s.pixHolder || ''} maxLength={80} onChange={e => set('pixHolder', e.target.value)} /></label>
      </div>

      <h3 className="pa-sec">Cadastros</h3>
      <label className="pa-check">
        <input type="checkbox" checked={!!s.inviteOnly} onChange={e => set('inviteOnly', e.target.checked)} />
        Somente com código de convite (novos cadastros exigem um código gerado na aba Convites)
      </label>

      {msg?.ok && <div className="pa-ok-box">{msg.ok}</div>}
      {msg?.err && <div className="pa-err-box">{msg.err}</div>}
      <div style={{ marginTop: 14 }}>
        <Button variant="primary" icon="check" disabled={busy} onClick={save}>{busy ? 'Salvando…' : 'Salvar configurações'}</Button>
      </div>
    </div>
  )
}

/* --------------------------- aba: convites -------------------------- */
function InvitesTab({ onSaved }) {
  const [invites, setInvites] = useState(null)
  const [only, setOnly] = useState(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { const r = await api('/api/panel/invites'); setInvites(r.invites); setOnly(r.invite_only) } catch { /* */ }
  }, [])
  useEffect(() => { load() }, [load])

  const gen = async () => {
    setBusy(true)
    try {
      const { invite } = await api('/api/panel/invites/new', { method: 'POST', body: JSON.stringify({ note }) })
      navigator.clipboard?.writeText(invite.code).catch(() => {})
      window.alert('Código gerado e copiado: ' + invite.code)
      setNote(''); load()
    } catch (e) { window.alert(e.message) } finally { setBusy(false) }
  }
  const revoke = async code => {
    if (!window.confirm('Revogar o código ' + code + '?')) return
    try { await api('/api/panel/invites/revoke', { method: 'POST', body: JSON.stringify({ code }) }); load() } catch (e) { window.alert(e.message) }
  }
  const toggleOnly = async () => {
    const next = !only
    try {
      await api('/api/panel/settings', { method: 'POST', body: JSON.stringify({ inviteOnly: next }) })
      setOnly(next); onSaved?.()
    } catch (e) { window.alert(e.message) }
  }

  const open = (invites || []).filter(i => !i.usedBy)
  const used = (invites || []).filter(i => i.usedBy)
  return (
    <div className="pa-box">
      <div className="pa-kv-head">
        <h3 className="pa-sec" style={{ margin: 0 }}>Códigos de convite</h3>
        <label className="pa-check"><input type="checkbox" checked={!!only} onChange={toggleOnly} /> Exigir convite para cadastro</label>
      </div>
      <div className="pa-inline-form" style={{ margin: '10px 0 14px' }}>
        <input className="input" placeholder="Observação (opcional)…" value={note} maxLength={60} onChange={e => setNote(e.target.value)} style={{ flex: 1 }} />
        <Button variant="primary" icon="plus" disabled={busy} onClick={gen}>Gerar código</Button>
      </div>
      {open.map(i => (
        <div className="pa-mini-row" key={i.code}>
          <div className="pa-item-main">
            <div className="pa-code">{i.code}</div>
            <div className="pa-item-meta">{i.note || 'sem observação'} · criado {fmtDate(i.created)}</div>
          </div>
          <div className="pa-item-actions">
            <Button size="sm" icon="clipboard" onClick={() => { navigator.clipboard?.writeText(i.code).catch(() => {}); window.alert('Copiado: ' + i.code) }}>Copiar</Button>
            <Button size="sm" danger icon="trash" onClick={() => revoke(i.code)} />
          </div>
        </div>
      ))}
      {used.map(i => (
        <div className="pa-mini-row" key={i.code}>
          <div className="pa-item-main"><div className="pa-code pa-dim">{i.code}</div><div className="pa-item-meta">usado por {i.usedByName || '—'} em {fmtDate(i.usedAt || i.created)}</div></div>
        </div>
      ))}
      {!open.length && !used.length && <div className="pa-empty">Nenhum código ainda — gere um para convidar alguém.</div>}
    </div>
  )
}

/* -------------------------- aba: manutenção -------------------------- */
function Maintenance({ ov }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [target, setTarget] = useState('all')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  const broadcast = async () => {
    if (!window.confirm(`Enviar push "${title}" para ${target === 'all' ? 'todos os usuários' : 'usuários ' + target}?`)) return
    setBusy(true); setMsg(null)
    try {
      const r = await api('/api/panel/broadcast', { method: 'POST', body: JSON.stringify({ title, body, target }) })
      setMsg({ ok: `Enviado para ${r.sent} dispositivo(s); ${r.skipped} sem push ou fora do alvo.` })
      setTitle(''); setBody('')
    } catch (e) { setMsg({ err: e.message }) } finally { setBusy(false) }
  }
  const tick = async () => {
    setBusy(true)
    try {
      const r = await api('/api/panel/tick', { method: 'POST', body: '{}' })
      setMsg({ ok: `Tick executado: ${r.timersFired || 0} timer(s) e ${r.remindersFired || 0} lembrete(s) disparados.` })
    } catch (e) { setMsg({ err: e.message }) } finally { setBusy(false) }
  }

  return (
    <>
      <div className="pa-box">
        <h3 className="pa-sec" style={{ marginTop: 0 }}>Enviar notificação (push) para os alunos</h3>
        <div className="pa-form-grid">
          <label className="pa-field"><span>Título (máx. 60)</span>
            <input className="input" value={title} maxLength={60} onChange={e => setTitle(e.target.value)} /></label>
          <label className="pa-field"><span>Para quem</span>
            <select className="pa-select" value={target} onChange={e => setTarget(e.target.value)}>
              <option value="all">Todos</option><option value="active">Assinantes ativos</option>
              <option value="trial">Em trial</option><option value="overdue">Vencidos (voltar a assinar)</option>
              <option value="free">Isentos</option>
            </select></label>
        </div>
        <label className="pa-field"><span>Mensagem (máx. 140)</span>
          <textarea className="input" value={body} maxLength={140} rows={2} onChange={e => setBody(e.target.value)} /></label>
        {msg?.ok && <div className="pa-ok-box">{msg.ok}</div>}
        {msg?.err && <div className="pa-err-box">{msg.err}</div>}
        <Button variant="primary" icon="bell" disabled={busy || !title || !body} onClick={broadcast}>Enviar agora</Button>
      </div>

      <div className="pa-box">
        <h3 className="pa-sec" style={{ marginTop: 0 }}>Operações</h3>
        <div className="pa-actions-grid">
          <Button icon="reset" disabled={busy} onClick={tick}>Rodar tick agora (timers e lembretes)</Button>
          <a className="pa-btn-a" href="/api/panel/backup" download><Icon name="download" /> Baixar backup completo (JSON)</a>
        </div>
        <div className="pa-item-meta">
          {ov ? `${ov.users} usuários · ${ov.users ? ov.by.active + ' ativos' : ''}` : ''}
          {' '}· o backup contém perfis, assinaturas, pagamentos e configurações — não contém segredos (hash de senha do painel incluído, guarde com cuidado).
        </div>
      </div>
    </>
  )
}

/* ------------------------------ shell ------------------------------ */
export default function AdminPanel({ onOut }) {
  const [tab, setTab] = useState('visao')
  const [ov, setOv] = useState(null)
  const [users, setUsers] = useState([])
  const [payments, setPayments] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [a, b, c] = await Promise.all([
        api('/api/panel/overview'),
        api('/api/panel/users'),
        api('/api/panel/payments')
      ])
      setOv(a); setUsers(b.users); setPayments(c.payments); setErr(null)
    } catch (e) {
      if (e.status === 401) onOut()   // sessão do painel expirou
      else setErr(e.message)
    } finally { setBusy(false) }
  }, [onOut])

  useEffect(() => { load() }, [load])
  // Re-silencioso a cada 30 s — pendências aparecem sozinhas no painel.
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  const act = useCallback(async (path, body, msg) => {
    setBusy(true)
    try {
      const r = await api(path, { method: 'POST', body: JSON.stringify(body || {}) })
      if (msg) window.alert(msg)
      await load()
      return r || { ok: true }
    } catch (e) { window.alert(e.message || 'Ação falhou'); return null }
    finally { setBusy(false) }
  }, [load])

  const logout = async () => {
    try { await api('/api/panel/logout', { method: 'POST', body: '{}' }) } catch { /* */ }
    onOut()
  }

  return (
    <div className="pa-page pa-wide">
      <header className="pa-head">
        <div className="pa-head-brand">
          <span className="pa-head-ic"><Icon name="shield" /></span>
          <div>
            <h1>Painel de administração</h1>
            <span className="pa-sub">Gestão total: usuários, assinaturas, pagamentos e aplicação</span>
          </div>
        </div>
        <div className="pa-head-actions">
          <Button size="sm" icon="reset" onClick={load} disabled={busy}>Atualizar</Button>
          <Button size="sm" icon="person" onClick={logout}>Sair</Button>
        </div>
      </header>

      <nav className="pa-nav">
        {TABS.map(t => (
          <button key={t.id} className={`pa-nav-btn${tab === t.id ? ' on' : ''}`} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} />
            {t.label}
            {t.id === 'users' && ` (${users.length})`}
            {t.id === 'payments' && ` (${payments.length})`}
          </button>
        ))}
      </nav>

      {err && <div className="pa-err-box">{err}</div>}

      {tab === 'visao' && ov && <Overview ov={ov} users={users} payments={payments} busy={busy} act={act} go={setTab} />}
      {tab === 'users' && <AdminUsers users={users} busy={busy} act={act} reload={load} />}
      {tab === 'payments' && <AdminPayments payments={payments} busy={busy} act={act} />}
      {tab === 'invites' && <InvitesTab onSaved={load} />}
      {tab === 'settings' && <SettingsTab onSaved={load} />}
      {tab === 'maint' && <Maintenance ov={ov} />}
    </div>
  )
}
