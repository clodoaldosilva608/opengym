/* Painel de administração — visão geral, gestão de usuários (isenção, desativar,
   estender) e aprovação de pagamentos Pix. Tudo PT-BR, tudo via /api/panel/*.   */
import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { Button, Segmented } from '../components/ui.jsx'

const STATUS = {
  free:    { label: 'Isento',   cls: 'free' },
  active:  { label: 'Ativo',    cls: 'active' },
  trial:   { label: 'Trial',    cls: 'trial' },
  overdue: { label: 'Vencido',  cls: 'overdue' }
}
const fmtBRL = v => {
  try { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  catch { return 'R$ ' + Number(v).toFixed(2).replace('.', ',') }
}
const fmtDate = iso => {
  try { return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: '2-digit' }) }
  catch { return iso || '—' }
}

function Stat({ label, value, tone }) {
  return (
    <div className={`pa-stat${tone ? ' ' + tone : ''}`}>
      <div className="pa-stat-v">{value}</div>
      <div className="pa-stat-l">{label}</div>
    </div>
  )
}

function StatusBadge({ code }) {
  const s = STATUS[code] || STATUS.overdue
  return <span className={`pa-badge ${s.cls}`}>{s.label}</span>
}

export default function AdminPanel({ onOut }) {
  const [tab, setTab] = useState('users')
  const [ov, setOv] = useState(null)
  const [users, setUsers] = useState([])
  const [payments, setPayments] = useState([])
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    setBusy(true)
    try {
      const [a, b, c] = await Promise.all([
        api('/api/panel/overview'),
        api('/api/panel/users'),
        api('/api/panel/payments')
      ])
      setOv(a); setUsers(b.users); setPayments(c.payments)
    } catch (e) {
      if (e.status === 401) onOut()   // sessão do painel expirou
    } finally { setBusy(false) }
  }, [onOut])

  useEffect(() => { load() }, [load])
  // Re-silencioso a cada 30 s — pendências Pix aparecem sozinhas no painel.
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t) }, [load])

  const act = async (path, body, msg) => {
    setBusy(true)
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body || {}) })
      if (msg) window.alert(msg)   // simples e à prova de duplo clique
      await load()
    } catch (e) { window.alert(e.message || 'Ação falhou') }
    finally { setBusy(false) }
  }

  const logout = async () => {
    try { await api('/api/panel/logout', { method: 'POST', body: '{}' }) } catch { /* */ }
    onOut()
  }

  const filtered = users.filter(u => !q || (u.name || '').toLowerCase().includes(q.toLowerCase()))
  const pending = payments.filter(p => p.status === 'pending')

  return (
    <div className="pa-page pa-wide">
      <header className="pa-head">
        <div className="pa-head-brand">
          <span className="pa-head-ic"><Icon name="shield" /></span>
          <div>
            <h1>Painel de administração</h1>
            <span className="pa-sub">Usuários, assinaturas e pagamentos</span>
          </div>
        </div>
        <div className="pa-head-actions">
          <Button size="sm" icon="reset" onClick={load} disabled={busy}>Atualizar</Button>
          <Button size="sm" icon="person" onClick={logout}>Sair</Button>
        </div>
      </header>

      {ov && (
        <div className="pa-stats">
          <Stat label="Usuários" value={ov.users} />
          <Stat label="Assinaturas ativas" value={ov.by.active} tone="ok" />
          <Stat label="Em trial" value={ov.by.trial} tone="warn" />
          <Stat label="Isentos" value={ov.by.free} />
          <Stat label="Vencidos" value={ov.by.overdue} tone="bad" />
          <Stat label="Pix pendentes" value={pending.length} tone={pending.length ? 'warn' : ''} />
          <Stat label={`Receita ${fmtBRL(ov.price)}/mês`} value={fmtBRL(ov.mrr)} tone="ok" />
          <Stat label="Recebido (30d)" value={fmtBRL(ov.revenue30)} />
        </div>
      )}

      <div className="pa-tabs">
        <Segmented
          options={[{ value: 'users', label: `Usuários (${users.length})` }, { value: 'payments', label: `Pagamentos (${payments.length})` }]}
          value={tab} onChange={setTab}
        />
      </div>

      {tab === 'users' && (
        <section className="pa-list">
          <div className="pa-toolbar">
            <input className="input" placeholder="Buscar por nome…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
          {filtered.map(u => {
            const b = u.billing || {}
            const pend = b.pendingId && b.pendingMethod === 'pix'
            return (
              <div className="pa-item" key={u.id}>
                <div className="pa-item-main">
                  <div className="pa-item-name">
                    {u.name}
                    <StatusBadge code={b.code} />
                    {u.disabled && <span className="pa-badge off">Desativado</span>}
                    {pend && <span className="pa-badge pix">Pix aguardando</span>}
                  </div>
                  <div className="pa-item-meta">
                    Criado {fmtDate(u.created)} · {u.workouts} treinos · última sync {u.lastSync ? fmtDate(u.lastSync) : 'nunca'}
                    {b.trialEndsAt && b.code === 'trial' && ` · trial até ${fmtDate(b.trialEndsAt)}`}
                    {b.periodEnd && (b.code === 'active' || b.code === 'free') && ` · acesso até ${fmtDate(b.periodEnd)}`}
                    {b.code === 'overdue' && b.trialEndsAt && ` · trial venceu ${fmtDate(b.trialEndsAt)}`}
                    {b.code === 'overdue' && b.periodEnd && ` · plano venceu ${fmtDate(b.periodEnd)}`}
                  </div>
                </div>
                <div className="pa-item-actions">
                  {pend && (
                    <Button size="sm" variant="primary" icon="check" disabled={busy}
                      onClick={() => act('/api/panel/payment/approve', { id: b.pendingId }, 'Pagamento aprovado — acesso liberado')}>
                      Aprovar Pix
                    </Button>
                  )}
                  <Button size="sm" disabled={busy}
                    onClick={() => act('/api/panel/user/free', { id: u.id, free: b.code !== 'free' })}>
                    {b.code === 'free' ? 'Retirar isenção' : 'Isentar'}
                  </Button>
                  {b.code !== 'free' && (
                    <Button size="sm" disabled={busy}
                      onClick={() => act('/api/panel/user/extend', { id: u.id, days: 30 })}>
                      +30 dias
                    </Button>
                  )}
                  <Button size="sm" danger disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`${u.disabled ? 'Reativar' : 'Desativar'} o perfil de ${u.name}?`)) return
                      act('/api/panel/user/disable', { id: u.id, disabled: !u.disabled })
                    }}>
                    {u.disabled ? 'Ativar' : 'Desativar'}
                  </Button>
                </div>
              </div>
            )
          })}
          {!filtered.length && <div className="pa-empty">Nenhum usuário encontrado.</div>}
        </section>
      )}

      {tab === 'payments' && (
        <section className="pa-list">
          {payments.map(p => (
            <div className="pa-item" key={p.id}>
              <div className="pa-item-main">
                <div className="pa-item-name">
                  {p.userName}
                  <span className={`pa-badge pay-${p.status}`}>
                    {p.status === 'pending' ? 'Pendente' : p.status === 'approved' ? 'Aprovado' : p.status === 'rejected' ? 'Rejeitado' : 'Falhou'}
                  </span>
                </div>
                <div className="pa-item-meta">
                  {fmtBRL(p.amount)} · {p.method === 'pix' ? 'Pix (manual)' : p.method === 'mp' ? 'Mercado Pago' : p.method} · aberto {fmtDate(p.createdAt)}
                  {p.approvedAt && ` · ${p.status === 'approved' ? 'aprovado' : 'resolvido'} ${fmtDate(p.approvedAt)}${p.approvedBy ? ' por ' + p.approvedBy : ''}`}
                </div>
              </div>
              <div className="pa-item-actions">
                {p.status === 'pending' && <>
                  <Button size="sm" variant="primary" icon="check" disabled={busy}
                    onClick={() => act('/api/panel/payment/approve', { id: p.id }, 'Pagamento aprovado — acesso liberado')}>
                    Aprovar
                  </Button>
                  <Button size="sm" danger disabled={busy}
                    onClick={() => { if (window.confirm('Rejeitar este pagamento?')) act('/api/panel/payment/reject', { id: p.id }) }}>
                    Rejeitar
                  </Button>
                </>}
              </div>
            </div>
          ))}
          {!payments.length && <div className="pa-empty">Nenhuma cobrança ainda. Ela aparece aqui quando um usuário paga o Pix e avisa no app.</div>}
        </section>
      )}
    </div>
  )
}
