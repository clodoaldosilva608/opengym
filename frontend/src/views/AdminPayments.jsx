/* Pagamentos do painel — lista com filtros, aprovar/rejeitar/apagar,
   exportação CSV e resumo do filtro atual. */
import { useMemo, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import { PAY_STATUS, METHOD_LABEL, fmtBRL, fmtDate, fmtDateTime } from './adminUtils.js'

const STATUSES = ['all', 'pending', 'approved', 'rejected', 'expired', 'failed', 'refunded', 'chargeback']
const METHODS = ['all', 'cakto', 'cakto-checkout', 'pix', 'mp']

function csvEsc(v) {
  const s = String(v ?? '')
  return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export default function AdminPayments({ payments, busy, act }) {
  const [status, setStatus] = useState('all')
  const [method, setMethod] = useState('all')
  const [q, setQ] = useState('')

  const filtered = useMemo(() => payments.filter(p => {
    if (status !== 'all' && p.status !== status) return false
    if (method !== 'all' && p.method !== method) return false
    const t = q.trim().toLowerCase()
    return !t || (p.userName || '').toLowerCase().includes(t) || (p.refId || '').toLowerCase().includes(t) || (p.caktoId || '').toLowerCase().includes(t)
  }), [payments, status, method, q])

  const approved = filtered.filter(p => p.status === 'approved').reduce((s, p) => s + (+p.amount || 0), 0)
  const pend = filtered.filter(p => p.status === 'pending').length

  const exportCsv = () => {
    const head = ['usuario', 'valor', 'moeda', 'metodo', 'status', 'aberto_em', 'resolvido_em', 'resolvido_por', 'ref_cakto']
    const rows = filtered.map(p => [p.userName, p.amount, p.currency, METHOD_LABEL[p.method] || p.method, PAY_STATUS[p.status] || p.status, p.createdAt, p.approvedAt || '', p.approvedBy || '', p.refId || ''])
    const csv = '\uFEFF' + [head, ...rows].map(r => r.map(csvEsc).join(';')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url; a.download = 'opengym-pagamentos-' + new Date().toISOString().slice(0, 10) + '.csv'
    a.click(); URL.revokeObjectURL(url)
  }

  return (
    <section className="pa-list">
      <div className="pa-toolbar">
        <div className="pa-filter-row">
          <input className="input pa-search" placeholder="Buscar por usuário ou código…" value={q} onChange={e => setQ(e.target.value)} />
          <select className="pa-select" value={status} onChange={e => setStatus(e.target.value)}>
            {STATUSES.map(s => <option key={s} value={s}>{s === 'all' ? 'Todos os status' : PAY_STATUS[s]}</option>)}
          </select>
          <select className="pa-select" value={method} onChange={e => setMethod(e.target.value)}>
            {METHODS.map(m => <option key={m} value={m}>{m === 'all' ? 'Todos os meios' : METHOD_LABEL[m]}</option>)}
          </select>
          <Button size="sm" icon="download" onClick={exportCsv} disabled={!filtered.length}>CSV</Button>
        </div>
        <div className="pa-item-meta">{filtered.length} cobrança(s) · {fmtBRL(approved)} aprovado(s) neste filtro · {pend} pendente(s)</div>
      </div>

      {filtered.map(p => (
        <div className="pa-item" key={p.id}>
          <div className="pa-item-main">
            <div className="pa-item-name">
              {p.userName}
              <span className={`pa-badge pay-${p.status}`}>{PAY_STATUS[p.status] || p.status}</span>
              <span className="pa-dim">{METHOD_LABEL[p.method] || p.method}</span>
            </div>
            <div className="pa-item-meta">
              {fmtBRL(p.amount)} · aberto {fmtDateTime(p.createdAt)}
              {p.approvedAt && ` · ${p.status === 'approved' ? 'aprovado' : 'resolvido'} ${fmtDateTime(p.approvedAt)}${p.approvedBy ? ' por ' + p.approvedBy : ''}`}
              {p.refId && ` · ref ${p.refId}`}
              {p.webhookDirect && ' · venda direta no checkout'}
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
            <Button size="sm" icon="trash" disabled={busy} aria-label="Apagar registro"
              onClick={() => { if (window.confirm('Apagar este registro de cobrança? (não afeta o acesso)')) act('/api/panel/payment/delete', { id: p.id }, 'Registro apagado') }} />
          </div>
        </div>
      ))}
      {!filtered.length && <div className="pa-empty">Nenhuma cobrança com estes filtros. Cobranças aparecem quando um usuário assina no app.</div>}
    </section>
  )
}
