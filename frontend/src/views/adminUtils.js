/* Utilidades compartilhadas do painel de administração. */
export const STATUS = {
  free:    { label: 'Isento',   cls: 'free' },
  active:  { label: 'Ativo',    cls: 'active' },
  trial:   { label: 'Trial',    cls: 'trial' },
  overdue: { label: 'Vencido',  cls: 'overdue' }
}

export const PAY_STATUS = {
  pending:   'Pendente',
  approved:  'Aprovado',
  rejected:  'Rejeitado',
  expired:   'Expirado',
  failed:    'Falhou',
  refunded:  'Reembolsado',
  chargeback: 'Contestado'
}

export const METHOD_LABEL = {
  pix: 'Pix (manual)',
  cakto: 'Cakto — Pix',
  'cakto-checkout': 'Cakto — Cartão/outros',
  mp: 'Mercado Pago'
}

export const fmtBRL = v => {
  try { return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }
  catch { return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',') }
}

export const fmtDate = iso => {
  try { return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: '2-digit' }) }
  catch { return iso || '—' }
}

export const fmtDateTime = iso => {
  try { return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) }
  catch { return iso || '—' }
}

export const maskDoc = d => {
  const x = String(d || '')
  return x.length >= 9 ? x.slice(0, 3) + '.' + x.slice(3, 6) + '.***-**' : (x || '—')
}
