/* Tela de assinatura — gate quando o perfil está vencido (trial acabou ou a
   mensalidade parou) e página "minha assinatura" nos demais estados, pela rota
   /billing dentro do app. Fluxos: Pix manual (chave + aprovação no painel) ou
   Mercado Pago (redirect).                                                      */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
  try { return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }) }
  catch { return iso }
}

export default function Billing() {
  const navigate = useNavigate()
  const { user, billing, config, refreshBilling, setUser } = useStore()
  const toast = m => useUI.getState().toast(m)

  const [cfg, setCfg] = useState({ brand: 'openGym', price: 14.9, currency: 'BRL', trialDays: 7, method: 'pix', pix: null })
  const [payment, setPayment] = useState(null)      // cobrança pendente aberta
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    const c = config?.billing
    if (c) setCfg({ brand: c.brand || 'openGym', price: c.price || 14.9, currency: c.currency || 'BRL', trialDays: c.trialDays ?? 7, method: c.method || 'none', pix: c.pix || null })
    // Já existe cobrança pendente? O checkout é idempotente: devolve a mesma cobrança,
    // então dá para recuperar o estado "aguardando confirmação" depois de recarregar a página.
    if (billing?.pending) {
      api('/api/billing/checkout', { method: 'POST', body: '{}' })
        .then(r => { if (r.payment) setPayment(r.payment) })
        .catch(() => {})
    }
  }, [config, billing?.pending])

  const code = billing?.code || 'overdue'
  const preco = fmt(cfg.price, cfg.currency)

  const checkout = async () => {
    setBusy(true)
    try {
      const r = await api('/api/billing/checkout', { method: 'POST', body: '{}' })
      if (r.initPoint) { window.location.href = r.initPoint; return }
      setPayment(r.payment)
      toast('Cobrança aberta — pague o Pix e aguarde a confirmação')
    } catch (e) { toast(e.message || 'Não foi possível abrir a cobrança') }
    finally { setBusy(false) }
  }

  const check = async () => {
    setChecking(true)
    try {
      const b = await refreshBilling()
      if (b && b.code !== 'overdue') { toast('Acesso liberado — bom treino!'); navigate('/home', { replace: true }) }
      else toast('Ainda não confirmado — se você acabou de pagar, aguarde alguns minutos e tente de novo')
    } finally { setChecking(false) }
  }

  const sair = async () => {
    try { await api('/api/logout', { method: 'POST', body: '{}' }) } catch { /* */ }
    setUser(null)
    navigate('/', { replace: true })
  }

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
          {cfg.method !== 'none' && (
            <Button variant="primary" size="lg" icon="bolt" disabled={busy} onClick={checkout}>
              Assinar agora ({preco}/mês)
            </Button>
          )}
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
            Este servidor ainda não tem método de pagamento configurado. Quem administra o serviço precisa definir a chave Pix ou o token do Mercado Pago.
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
