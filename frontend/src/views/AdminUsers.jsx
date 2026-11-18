/* Gestão de usuários do painel — CRUD completo:
   listar/filtrar/ordenar, detalhe completo, renomear, isentar, estender,
   definir período, reiniciar trial, nota interna, encerrar sessões,
   limpar dados, desativar/reativar e excluir perfil. */
import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { STATUS, PAY_STATUS, METHOD_LABEL, fmtBRL, fmtDate, fmtDateTime, maskDoc } from './adminUtils.js'

function StatusBadge({ code }) {
  const s = STATUS[code] || STATUS.overdue
  return <span className={`pa-badge ${s.cls}`}>{s.label}</span>
}

/* ---------------- modal de detalhe do usuário ---------------- */
function UserDetail({ id, act, busy, reload, close }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  const [renaming, setRenaming] = useState(false)
  const [newName, setNewName] = useState('')
  const [note, setNote] = useState('')
  const [extDays, setExtDays] = useState(30)
  const [untilDate, setUntilDate] = useState('')
  const [trialDays, setTrialDays] = useState(7)

  const load = async () => {
    try { const r = await api('/api/panel/user?id=' + encodeURIComponent(id)); setD(r); setNote(r.user?.billing?.note || ''); setNewName(r.user?.name || '') }
    catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [id])

  const run = async (path, body, msg) => { await act(path, body, msg); await load(); reload() }
  if (err) return <div className="pa-modal-card"><div className="pa-empty">{err}</div><button className="pa-close" onClick={close}><Icon name="xmark" /></button></div>
  if (!d) return <div className="pa-modal-card"><div className="pa-empty">Carregando…</div></div>

  const u = d.user
  const b = u.billing || {}
  const st = u.status || {}

  const remove = async () => {
    const typed = window.prompt(`Isto exclui ${u.name}, os treinos, as passkeys e o histórico de pagamentos. Digite o nome do perfil para confirmar:`)
    if (typed == null) return
    const r = await act('/api/panel/user/delete', { id: u.id, confirm: typed }, null)
    if (r) { close(); reload() }
  }
  const wipe = async () => {
    if (!window.confirm('Apagar TODOS os treinos, rotinas e pesos deste perfil? A conta continua.')) return
    run('/api/panel/user/wipe-data', { id: u.id }, 'Dados de treino apagados')
  }
  const logoutAll = async () => {
    run('/api/panel/user/logout-all', { id: u.id }, 'Sessões encerradas — o perfil precisa entrar de novo')
  }

  return (
    <div className="pa-modal-card">
      <button className="pa-close" onClick={close} aria-label="Fechar"><Icon name="xmark" /></button>
      <div className="pa-modal-head">
        <h2>{u.name} <StatusBadge code={st.code} /></h2>
        <div className="pa-item-meta">
          id <code>{u.id.slice(0, 10)}…</code> · criado {fmtDate(u.created)} · {d.passkeys} passkey(s) · {d.pushes} push
          {u.invitedBy && ` · convite ${u.invitedBy}`}
        </div>
        <div className="pa-item-meta">
          {u.email || 'sem e-mail'} · {u.phone || 'sem telefone'} · CPF {maskDoc(u.docNumber)}
          {u.admin && ' · admin do app'}
          {u.disabled && ' · desativado'}
        </div>
        {renaming ? (
          <div className="pa-inline-form">
            <input className="input" value={newName} onChange={e => setNewName(e.target.value)} maxLength={40} />
            <Button size="sm" variant="primary" onClick={async () => { await run('/api/panel/user/rename', { id: u.id, name: newName }, 'Nome alterado'); setRenaming(false) }}>Salvar</Button>
            <Button size="sm" onClick={() => setRenaming(false)}>Cancelar</Button>
          </div>
        ) : (
          <Button size="sm" icon="pencil" onClick={() => setRenaming(true)}>Renomear</Button>
        )}
      </div>

      <div className="pa-tiles">
        <div className="pa-tile"><div className="v">{d.stats.workouts}</div><div className="l">treinos</div></div>
        <div className="pa-tile"><div className="v">{d.stats.routines}</div><div className="l">rotinas</div></div>
        <div className="pa-tile"><div className="v">{d.stats.bodyweight}</div><div className="l">pesagens</div></div>
        <div className="pa-tile"><div className="v">{d.stats.lastSync ? fmtDate(d.stats.lastSync) : 'nunca'}</div><div className="l">última sync</div></div>
        <div className="pa-tile"><div className="v">{d.stats.lastWorkout ? fmtDate(d.stats.lastWorkout) : '—'}</div><div className="l">último treino</div></div>
        <div className="pa-tile"><div className="v">{d.stats.reminder ? `${d.stats.reminder.time}` : 'off'}</div><div className="l">lembrete</div></div>
      </div>

      <h3 className="pa-sec">Assinatura</h3>
      <div className="pa-sub-block">
        <div className="pa-item-meta">
          Status: <strong>{STATUS[st.code]?.label || st.code}</strong>
          {b.trialEndsAt && ` · trial até ${fmtDateTime(b.trialEndsAt)}`}
          {b.periodEnd && ` · acesso até ${fmtDateTime(b.periodEnd)}`}
          {b.grandfathered && ' · perfil pré-existente'}
        </div>
        {b.note && <div className="pa-item-meta">Nota: {b.note}</div>}
        <div className="pa-actions-grid">
          <Button size="sm" disabled={busy} onClick={() => run('/api/panel/user/free', { id: u.id, free: st.code !== 'free' }, st.code === 'free' ? 'Isenção retirada' : 'Perfil isentado')}>
            {st.code === 'free' ? 'Retirar isenção' : 'Isentar'}
          </Button>
          <div className="pa-inline-form">
            <input className="input" type="number" min="1" max="365" value={extDays} onChange={e => setExtDays(e.target.value)} style={{ width: 76 }} />
            <Button size="sm" disabled={busy} onClick={() => run('/api/panel/user/extend', { id: u.id, days: +extDays }, `Acesso estendido em ${extDays} dias`)}>+{extDays} dias</Button>
          </div>
          <div className="pa-inline-form">
            <input className="input" type="date" value={untilDate} onChange={e => setUntilDate(e.target.value)} />
            <Button size="sm" disabled={busy || !untilDate} onClick={() => run('/api/panel/user/period', { id: u.id, status: 'active', periodEnd: new Date(untilDate + 'T12:00:00').toISOString() }, 'Data de acesso definida')}>Definir acesso até</Button>
          </div>
          <div className="pa-inline-form">
            <input className="input" type="number" min="1" max="365" value={trialDays} onChange={e => setTrialDays(e.target.value)} style={{ width: 64 }} />
            <Button size="sm" disabled={busy} onClick={() => { if (window.confirm(`Reiniciar o trial de ${u.name} por ${trialDays} dias?`)) run('/api/panel/user/reset-trial', { id: u.id, days: +trialDays }, 'Trial reiniciado') }}>Reiniciar trial</Button>
          </div>
          <Button size="sm" disabled={busy} onClick={() => run('/api/panel/user/period', { id: u.id, status: 'overdue', periodEnd: null }, 'Acesso marcado como vencido')}>Marcar vencido</Button>
          <Button size="sm" icon="signOut" disabled={busy} onClick={logoutAll}>Encerrar sessões</Button>
          <Button size="sm" danger disabled={busy} onClick={() => {
            if (!window.confirm(`${u.disabled ? 'Reativar' : 'Desativar'} o perfil de ${u.name}?`)) return
            run('/api/panel/user/disable', { id: u.id, disabled: !u.disabled }, u.disabled ? 'Perfil reativado' : 'Perfil desativado')
          }}>{u.disabled ? 'Ativar conta' : 'Desativar conta'}</Button>
        </div>
        <div className="pa-inline-form" style={{ marginTop: 8 }}>
          <input className="input" placeholder="Nota interna sobre este perfil…" value={note} onChange={e => setNote(e.target.value)} maxLength={200} style={{ flex: 1 }} />
          <Button size="sm" disabled={busy || note === (b.note || '')} onClick={() => run('/api/panel/user/note', { id: u.id, note }, 'Nota salva')}>Salvar nota</Button>
        </div>
      </div>

      <h3 className="pa-sec">Pagamentos ({d.payments.length})</h3>
      <div className="pa-sub-block">
        {d.payments.map(p => (
          <div className="pa-mini-row" key={p.id}>
            <div className="pa-item-main">
              <div className="pa-item-name">
                {fmtBRL(p.amount)}
                <span className={`pa-badge pay-${p.status}`}>{PAY_STATUS[p.status] || p.status}</span>
                <span className="pa-dim">{METHOD_LABEL[p.method] || p.method}</span>
              </div>
              <div className="pa-item-meta">
                aberto {fmtDateTime(p.createdAt)}{p.approvedAt && ` · resolvido ${fmtDateTime(p.approvedAt)}${p.approvedBy ? ' por ' + p.approvedBy : ''}`}{p.refId && ` · ref ${p.refId}`}
              </div>
            </div>
            <div className="pa-item-actions">
              {p.status === 'pending' && <>
                <Button size="sm" variant="primary" icon="check" onClick={() => run('/api/panel/payment/approve', { id: p.id }, 'Pagamento aprovado')}>Aprovar</Button>
                <Button size="sm" danger onClick={() => { if (window.confirm('Rejeitar?')) run('/api/panel/payment/reject', { id: p.id }, 'Pagamento rejeitado') }}>Rejeitar</Button>
              </>}
              <Button size="sm" icon="trash" onClick={() => { if (window.confirm('Apagar este registro de cobrança?')) run('/api/panel/payment/delete', { id: p.id }, 'Registro apagado') }} />
            </div>
          </div>
        ))}
        {!d.payments.length && <div className="pa-dim">Nenhuma cobrança deste perfil.</div>}
      </div>

      <h3 className="pa-sec">Rotinas</h3>
      <div className="pa-sub-block">
        {d.routines.length
          ? d.routines.map(r => <div className="pa-mini-row" key={r.id}><span>{r.emoji || '·'} {r.name}</span><span className="pa-dim">{r.count} exercícios</span></div>)
          : <div className="pa-dim">Nenhuma rotina criada.</div>}
      </div>

      <h3 className="pa-sec danger">Zona de risco</h3>
      <div className="pa-sub-block pa-danger-zone">
        <Button size="sm" danger icon="reset" onClick={wipe}>Apagar dados de treino</Button>
        <Button size="sm" danger icon="trash" onClick={remove}>Excluir perfil permanentemente</Button>
      </div>
    </div>
  )
}

/* ---------------- lista de usuários ---------------- */
export default function AdminUsers({ users, busy, act, reload }) {
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('created')
  const [openId, setOpenId] = useState(null)

  const filtered = useMemo(() => {
    let list = users.filter(u => {
      const t = q.trim().toLowerCase()
      const hitQ = !t || (u.name || '').toLowerCase().includes(t) || (u.email || '').toLowerCase().includes(t) || (u.id || '').toLowerCase().includes(t)
      const hitF = filter === 'all' ? true : filter === 'disabled' ? u.disabled : (u.billing?.code === filter)
      return hitQ && hitF
    })
    const by = {
      created: (a, b) => (b.created || '').localeCompare(a.created || ''),
      name: (a, b) => (a.name || '').localeCompare(b.name || '', 'pt-BR'),
      sync: (a, b) => (b.lastSync || 0) - (a.lastSync || 0),
      workouts: (a, b) => (b.workouts || 0) - (a.workouts || 0)
    }
    return list.slice().sort(by[sort] || by.created)
  }, [users, q, filter, sort])

  const counts = useMemo(() => {
    const c = { all: users.length, free: 0, active: 0, trial: 0, overdue: 0, disabled: 0 }
    for (const u of users) {
      if (u.disabled) c.disabled++
      c[u.billing?.code] = (c[u.billing?.code] || 0) + 1
    }
    return c
  }, [users])

  return (
    <section className="pa-list">
      <div className="pa-toolbar">
        <input className="input pa-search" placeholder="Buscar por nome, e-mail ou id…" value={q} onChange={e => setQ(e.target.value)} />
        <div className="pa-filter-row">
          <select className="pa-select" value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="all">Todos ({counts.all})</option>
            <option value="active">Ativos ({counts.active || 0})</option>
            <option value="trial">Trial ({counts.trial || 0})</option>
            <option value="overdue">Vencidos ({counts.overdue || 0})</option>
            <option value="free">Isentos ({counts.free || 0})</option>
            <option value="disabled">Desativados ({counts.disabled})</option>
          </select>
          <select className="pa-select" value={sort} onChange={e => setSort(e.target.value)}>
            <option value="created">Mais recentes</option>
            <option value="name">Nome A–Z</option>
            <option value="sync">Última sync</option>
            <option value="workouts">Mais treinos</option>
          </select>
        </div>
      </div>

      {filtered.map(u => {
        const b = u.billing || {}
        const pend = b.pendingId
        return (
          <div className="pa-item" key={u.id}>
            <div className="pa-item-main pa-clickable" onClick={() => setOpenId(u.id)} role="button" tabIndex={0}>
              <div className="pa-item-name">
                {u.name}
                <StatusBadge code={b.code} />
                {u.disabled && <span className="pa-badge off">Desativado</span>}
                {pend && <span className="pa-badge pix">Pendente</span>}
              </div>
              <div className="pa-item-meta">
                {u.email ? u.email + ' · ' : ''}{u.workouts} treinos · criado {fmtDate(u.created)} · sync {u.lastSync ? fmtDate(u.lastSync) : 'nunca'}
                {b.trialEndsAt && b.code === 'trial' && ` · trial até ${fmtDate(b.trialEndsAt)}`}
                {b.periodEnd && (b.code === 'active' || b.code === 'free') && ` · acesso até ${fmtDate(b.periodEnd)}`}
                {b.note && ` · nota: ${b.note}`}
              </div>
            </div>
            <div className="pa-item-actions">
              {pend && (
                <Button size="sm" variant="primary" icon="check" disabled={busy}
                  onClick={() => act('/api/panel/payment/approve', { id: b.pendingId }, 'Pagamento aprovado — acesso liberado')}>
                  Aprovar
                </Button>
              )}
              <Button size="sm" disabled={busy} onClick={() => act('/api/panel/user/free', { id: u.id, free: b.code !== 'free' })}>
                {b.code === 'free' ? 'Retirar isenção' : 'Isentar'}
              </Button>
              {b.code !== 'free' && (
                <Button size="sm" disabled={busy} onClick={() => act('/api/panel/user/extend', { id: u.id, days: 30 })}>+30d</Button>
              )}
              <Button size="sm" icon="expand" onClick={() => setOpenId(u.id)}>Gerir</Button>
            </div>
          </div>
        )
      })}
      {!filtered.length && <div className="pa-empty">Nenhum usuário encontrado com estes filtros.</div>}

      {openId && (
        <div className="pa-modal" onClick={e => { if (e.target === e.currentTarget) setOpenId(null) }}>
          <UserDetail id={openId} act={act} busy={busy} reload={reload} close={() => setOpenId(null)} />
        </div>
      )}
    </section>
  )
}
