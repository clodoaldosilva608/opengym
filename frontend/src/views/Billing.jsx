/* Tela de assinatura — gate quando o perfil está vencido (trial acabou ou a
   mensalidade parou) e página "minha assinatura" nos demais estados, pela rota
   /billing dentro do app. Fluxos:
     'cakto' — Cakto: coleta e-mail/telefone/CPF, gera Pix (QR copia-e-cola) na
               hora e libera o acesso automaticamente pelo webhook do Cakto.
     'pix'   — manual: mostra a chave Pix, o usuário avisa, o admin aprova.
     'mp'    — Mercado Pago (redirect).                                       */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import '../styles/billing.css'

const fmt = (v, currency) => {
  try { return v.toLocaleString('pt-BR', { style: 'currency', currency }) }
  catch { return 'R$ ' + Number(v).toFixed(2).replace('.', ',') }
}
const fmtDate = iso => {
  try { return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) }
  catch { return iso }
}
const maskPhone = v => {
  const d = (v || '').replace(/\D/g, '').replace(/^55/, '').slice(0, 11)
  if (d.length <= 2) return d
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
}
const maskCPF = v => {
  const d = (v || '').replace(/\D/g, '').slice(0, 11)
  if (d.length <= 3) return d
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`
}

export default function Billing() {
  const navigate = useNavigate()
  const { user, billing, config, refreshBilling, setUser } = useStore()
  const toast = m => useUI.getState().toast(m)

  const [cfg, setCfg] = useState({ brand: 'openGym', price: 14.9, currency: 'BRL', trialDays: 7, method: 'pix', pix: null })
  const [payment, setPayment] = useState(null)      // cobrança pendente aberta
  const [qrImg, setQrImg] = useState('')            // QR renderizado localmente
  const [form, setForm] = useState({ email: '', phone: '', docNumber: '' })
  const [showPay, setShowPay] = useState(false)     // abrir formulário nos estados positivos
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const c = config?.billing
    if (c) setCfg({ brand: c.brand || 'openGym', price: c.price || 14.9, currency: c.currency || 'BRL', trialDays: c.trialDays ?? 7, method: c.method || 'none', pix: c.pix || null })
  }, [config])

  // Restaurar cobrança pendente (QR do Pix) depois de recarregar a página.
  useEffect(() => {
    if (billing?.pending) {
      api('/api/billing/pending').then(r => { if (r.payment) setPayment(r.payment) }).catch(() => {})
    }
  }, [billing?.pending])

  // Pré-preencher dados do pagador salvos no perfil (das mensalidades anteriores).
  useEffect(() => {
    const p = billing?.payer
    if (!p) return
    setForm(f => ({ ...f, email: p.email || f.email, phone: p.phone ? maskPhone(p.phone) : f.phone }))
    setDocReady(!!p.docReady)
  }, [billing?.payer])

  const [docReady, setDocReady] = useState(false)

  // Renderiza o QR Code do Pix localmente (BR Code copia-e-cola → imagem).
  useEffect(() => {
    if (payment?.qrCode) {
      QRCode.toDataURL(payment.qrCode, { width: 288, margin: 1, errorCorrectionLevel: 'M' })
        .then(setQrImg).catch(() => setQrImg(''))
    } else setQrImg('')
  }, [payment?.qrCode])

  const code = billing?.code || 'overdue'
  const preco = fmt(cfg.price, cfg.currency)
  const qrExpired = !!(payment?.qrExpiresAt && +new Date(payment.qrExpiresAt) < Date.now())

  const checkout = async ev => {
    ev?.preventDefault?.()
    setBusy(true)
    try {
      const body = cfg.method === 'cakto'
        ? { email: form.email.trim(), phone: form.phone, docNumber: form.docNumber }
        : {}
      const r = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify(body) })
      if (r.initPoint) { window.location.href = r.initPoint; return }
      setPayment(r.payment)
      setShowPay(false)
      if (r.payment?.qrCode) toast('Pix gerado — escaneie o QR ou copie o código')
      else if (r.payment) toast('Cobrança aberta — aguarde a confirmação')
    } catch (e) { toast(e.message || 'Não foi possível abrir a cobrança') }
    finally { setBusy(false) }
  }

  const copyPix = () => {
    navigator.clipboard?.writeText(payment?.qrCode || '').then(() => toast('Código Pix copiado'))
      .catch(() => toast('Não foi possível copiar — selecione o código manualmente'))
  }

  const check = async () => {
    setChecking(true)
    try {
      const b = await refreshBilling()
      if (b && b.code !== 'overdue') { toast('Acesso liberado — bom treino!'); navigate('/home', { replace: true }) }
      else toast('Ainda não confirmado — se você acabou de pagar, aguarde alguns segundos e tente de novo')
    } finally { setChecking(false) }
  }

  const sair = async () => {
    try { await api('/api/logout', { method: 'POST', body: '{}' }) } catch { /* */ }
    setUser(null)
    navigate('/', { replace: true })
  }

  /* ---------- seção de pagamento (compartilhada pelos estados) ---------- */
  const paySection = cfg.method === 'cakto' && (
    <>
      {!payment && (showPay || code === 'overdue') && (
        <form className="bi-pix" onSubmit={checkout}>
          <div className="bi-pix-hint">
            {code === 'overdue'
              ? 'Preencha os dados do pagador — o Pix é gerado na hora e seu acesso é liberado automaticamente após o pagamento:'
              : 'Preencha os dados do pagador para gerar o Pix da próxima mensalidade:'}
          </div>
          <label className="bi-field">
            <span>E-mail (recebe o comprovante)</span>
            <input type="email" inputMode="email" autoComplete="email" placeholder="voce@email.com"
              value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
          </label>
          <label className="bi-field">
            <span>Telefone (WhatsApp do pagador)</span>
            <input type="tel" inputMode="tel" autoComplete="tel" placeholder="(11) 91234-5678"
              value={form.phone} onChange={e => setForm({ ...form, phone: maskPhone(e.target.value) })} required />
          </label>
          <label className="bi-field">
            <span>CPF do pagador</span>
            <input inputMode="numeric" autoComplete="off" placeholder="000.000.000-00"
              value={form.docNumber} onChange={e => setForm({ ...form, docNumber: maskCPF(e.target.value) })} required={code === 'overdue' || !docReady} />
          </label>
          <Button variant="primary" size="lg" icon="bolt" disabled={busy}>
            {busy ? 'Gerando Pix…' : `Gerar Pix (${preco})`}
          </Button>
          <div className="bi-hint">O acesso é liberado automaticamente segundos depois de pagar — sem esperar aprovação manual.</div>
        </form>
      )}

      {!payment && !(showPay || code === 'overdue') && (
        <Button variant="primary" size="lg" icon="bolt" onClick={() => setShowPay(true)}>
          Assinar agora ({preco}/mês)
        </Button>
      )}

      {payment && (
        <div className="bi-qrcode">
          <div className="bi-qrcode-head">
            <strong>Pix gerado — {fmt(payment.amount, payment.currency)}</strong>
            {payment.refId && <span className="bi-qrcode-ref">código {payment.refId}</span>}
          </div>
          {qrImg && <img className="bi-qrcode-img" src={qrImg} alt="QR Code do Pix" width={220} height={220} />}
          {qrExpired && (
            <div className="bi-warn">Este QR expirou. Clique em “Gerar novo Pix” abaixo.</div>
          )}
          {!qrExpired && payment.qrExpiresAt && (
            <div className="bi-hint" style={{ marginTop: 6 }}>Válido até {fmtDate(payment.qrExpiresAt)}</div>
          )}
          <div className="bi-brcode">{payment.qrCode || '—'}</div>
          <div className="bi-qrcode-actions">
            <Button size="sm" icon="clipboard" onClick={copyPix}>Copiar código Pix</Button>
            {payment.checkoutUrl && (
              <a className="bi-checkout-link" href={payment.checkoutUrl} target="_blank" rel="noreferrer">
                Pagar no checkout Cakto (cartão)
              </a>
            )}
          </div>
          <Button variant="primary" size="lg" icon="reset" disabled={checking} onClick={check}>
            {checking ? 'Verificando…' : 'Já paguei — verificar acesso'}
          </Button>
          <div className="bi-hint">Assim que o pagamento cair, o acesso é liberado automaticamente (normalmente em segundos).</div>
          <button className="bi-regen" onClick={checkout} disabled={busy}>Gerar novo Pix</button>
        </div>
      )}
    </>
  )

  /* ----- estados positivos: página "minha assinatura" ----- */
  if (code !== 'overdue') {
    const heads = {
      free:   { ic: 'shield',  t: 'Acesso liberado', d: 'Este perfil tem acesso gratuito concedido pela administração.' },
      active: { ic: 'check',   t: 'Assinatura ativa', d: billing?.periodEnd ? `Seu acesso vai até ${fmtDate(billing.periodEnd)}. Renove para não perder o ritmo.` : 'Seu acesso está em dia.' },
      trial:  { ic: 'timer',   t: 'Período de avaliação', d: billing?.trialEndsAt ? `Seu período grátis termina em ${fmtDate(billing.trialEndsAt)}. Assine para continuar sem interrupção.` : 'Período de avaliação em andamento.' }
    }
    const h = heads[code] || heads.active
    return (
      <div className="bi-page">
        <div className="bi-card">
          <div className="bi-logo"><Icon name="dumbbell" /></div>
          <h1>{cfg.brand}</h1>
          <div className="bi-status ok">
            <div className="bi-status-ic ok"><Icon name={h.ic} /></div>
            <h2>{h.t}</h2>
            <p>{h.d}</p>
          </div>
          <div className="bi-price">
            <span className="bi-price-val"><strong>{preco}</strong>/mês</span>
            <span className="bi-price-tag">sem fidelidade · cancele quando quiser</span>
          </div>
          {cfg.method !== 'none' && cfg.method !== 'cakto' && (
            <Button variant="primary" size="lg" icon="bolt" disabled={busy} onClick={checkout}>
              Assinar agora ({preco}/mês)
            </Button>
          )}
          {paySection}
          <div className="bi-foot">
            {code !== 'free' && code !== 'active' && <button onClick={check} disabled={checking}>Verificar meu acesso</button>}
            {code !== 'free' && code !== 'active' && <span className="bi-dot">·</span>}
            <button onClick={() => navigate('/home', { replace: true })}>Voltar ao app</button>
            <span className="bi-dot">·</span>
            <button onClick={sair}>Sair</button>
          </div>
          <div className="bi-user" style={{ color: 'var(--label-3)' }}>Conectado como <strong>{user?.name}</strong></div>
        </div>
      </div>
    )
  }

  /* ----- gate: vencido ----- */
  const venceuTrial = !!(billing?.trialEndsAt && !billing?.periodEnd)

  return (
    <div className="bi-page">
      <div className="bi-card">
        <div className="bi-logo"><Icon name="dumbbell" /></div>
        <h1>{cfg.brand}</h1>

        <div className="bi-status">
          <div className="bi-status-ic"><Icon name="timer" /></div>
          <h2>{venceuTrial ? 'Seu período grátis terminou' : 'Assinatura inativa'}</h2>
          <p>
            {billing?.trialEndsAt ? `O período de avaliação venceu em ${fmtDate(billing.trialEndsAt)}.` :
             billing?.periodEnd ? `O último período pago venceu em ${fmtDate(billing.periodEnd)}.` :
             'Este perfil não tem assinatura ativa.'}{' '}
            Assine o plano mensal para voltar a treinar — seu histórico está guardado e volta intacto.
          </p>
        </div>

        <div className="bi-price">
          <span className="bi-price-val"><strong>{preco}</strong>/mês</span>
          <span className="bi-price-tag">sem fidelidade · cancele quando quiser</span>
        </div>

        {cfg.method === 'none' && (
          <div className="bi-warn">
            Este servidor ainda não tem método de pagamento configurado. Quem administra o serviço precisa definir as credenciais de pagamento (Cakto, Mercado Pago ou chave Pix).
          </div>
        )}

        {cfg.method === 'pix' && !payment && (
          <div className="bi-pix">
            <div className="bi-pix-hint">Pague com Pix e o acesso é liberado após confirmação:</div>
            <div className="bi-pix-key">
              <div>
                <div className="bi-pix-label">Chave Pix {cfg.pix?.holder ? `· titular ${cfg.pix.holder}` : ''}</div>
                <div className="bi-pix-val">{cfg.pix?.key || '—'}</div>
              </div>
              <Button size="sm" icon="clipboard" onClick={() => {
                navigator.clipboard?.writeText(cfg.pix?.key || '').then(() => toast('Chave Pix copiada'))
              }}>Copiar</Button>
            </div>
            <div className="bi-pix-amount">Valor: <strong>{preco}</strong> · 30 dias de acesso</div>
            <Button variant="primary" size="lg" icon="check" disabled={busy} onClick={checkout}>
              Já paguei — avisar o sistema
            </Button>
            <div className="bi-hint">O administrador confirma o recebimento e seu acesso é liberado na hora.</div>
          </div>
        )}

        {cfg.method === 'pix' && payment && (
          <div className="bi-pending">
            <div className="bi-pending-ic"><Icon name="clock" /></div>
            <strong>Aguardando confirmação do pagamento</strong>
            <p>Cobrança aberta em {fmtDate(payment.createdAt)} · {fmt(payment.amount, payment.currency)} via Pix.<br />
              Assim que o administrador confirmar, clique em “Verificar”.</p>
            <Button variant="primary" size="lg" icon="reset" disabled={checking} onClick={check}>
              {checking ? 'Verificando…' : 'Verificar agora'}
            </Button>
          </div>
        )}

        {cfg.method === 'mp' && (
          <div className="bi-mp">
            <Button variant="primary" size="lg" icon="bolt" disabled={busy} onClick={checkout}>
              Assinar via Mercado Pago
            </Button>
            <div className="bi-hint">Cartão ou Pix pelo Mercado Pago. Depois de pagar, volte a esta tela e verifique.</div>
          </div>
        )}

        {cfg.method === 'cakto' && paySection}

        <div className="bi-foot">
          <button onClick={check} disabled={checking}>Verificar meu acesso</button>
          <span className="bi-dot">·</span>
          <button onClick={sair}>Sair</button>
          <span className="bi-dot">·</span>
          <button onClick={() => navigate('/')}>Início</button>
        </div>
        <div className="bi-user" style={{ color: 'var(--label-3)' }}>
          Conectado como <strong>{user?.name}</strong>
        </div>
      </div>
    </div>
  )
}
