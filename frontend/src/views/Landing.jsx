/* Landing page pública (server flavor) — marketing, preço e rodapé com acesso ao painel.
   Todo o texto é PT-BR de propósito: é a vitrine do serviço para o público brasileiro.
   Atenção: sob HashRouter NÃO se pode usar href="#âncora" (o hash é o roteador) —
   toda navegação interna de página usa scrollIntoView via onClick.                */
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'
import '../styles/landing.css'

const FALLBACK = { brand: 'openGym', price: 14.9, currency: 'BRL', trialDays: 7, method: 'pix' }
const fmt = (v, currency) => {
  try { return v.toLocaleString('pt-BR', { style: 'currency', currency }) }
  catch { return 'R$ ' + Number(v).toFixed(2).replace('.', ',') }
}
const scrollTo = id => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

function Shot({ src, alt, tilt }) {
  return (
    <div className={`lg-shot${tilt ? ' tilt' : ''}`}>
      <img src={src} alt={alt} loading="lazy" />
    </div>
  )
}

const FEATURES = [
  { icon: 'calendar', t: 'Planilha que se remonta', d: 'Uma rotina por dia da semana. Vida apertou? Remaneje o treino de hoje sem bagunçar o plano inteiro.' },
  { icon: 'barbell', t: 'Treino guiado, série a série', d: 'Os pesos do último treino já vêm preenchidos, o descanso é cronometrado e o PR é anunciado na hora.' },
  { icon: 'chart', t: 'Progressão com regra', d: 'Linear, Greyskull LP ou dupla progressão por exercício — as metas do dia chegam prontas, dizendo de onde vieram.' },
  { icon: 'arm', t: 'Mapa muscular', d: 'Veja o volume por grupo, o que ainda está fatigado e o que a semana esqueceu de treinar.' },
  { icon: 'scale', t: 'Peso corporal com meta', d: 'Gráfico interativo com a linha do seu objetivo. Cada mudança é colorida pelo caminho dela.' },
  { icon: 'shield', t: 'Privado por padrão', d: 'Login por passkey (Face ID ou digital), sem anúncios, sem telemetria. Exporte seus dados em JSON quando quiser.' },
]

const FAQ = [
  { q: 'Preciso de cartão de crédito para testar?', a: 'Não. Crie seu perfil e use tudo por 7 dias grátis. Só depois, se gostar, assina o mensal — sem fidelidade e sem cobrança automática surpresa.' },
  { q: 'Como funciona o pagamento?', a: 'Assinatura mensal de R$ 14,90 por Pix (confirmação em minutos) ou cartão via Mercado Pago, conforme a configuração do serviço. Você paga mês a mês; para parar, basta não renovar.' },
  { q: 'Funciona no celular?', a: 'Sim — abra no navegador e instale como aplicativo (adicionar à tela de início). Ele continua funcionando dentro do ginásio, inclusive com a tela ligada durante o treino.' },
  { q: 'Onde ficam meus dados?', a: 'No servidor do serviço, vinculados apenas ao seu perfil. Nada é vendido nem compartilhado. Você pode exportar tudo em JSON nas configurações a qualquer momento e pedir a exclusão do perfil quando quiser.' },
  { q: 'Já uso outro app de treino. Dá para trazer meu histórico?', a: 'Dá. O app importa treinos do FitNotes, Strong e Hevy (com o RPE registrado) e o peso corporal direto de uma exportação do Apple Health.' },
]

export default function Landing() {
  const navigate = useNavigate()
  const config = useStore(s => s.config)
  const [b, setB] = useState(FALLBACK)
  useEffect(() => {
    if (config?.billing) setB({ ...FALLBACK, ...config.billing })
  }, [config])
  const preco = fmt(b.price, b.currency)
  const trial = b.trialDays > 0 ? `${b.trialDays} dias grátis` : 'sem período de teste'

  return (
    <div className="lg-page">
      <nav className="lg-nav">
        <div className="lg-nav-in">
          <a className="lg-brand" onClick={() => scrollTo('top')}><Icon name="dumbbell" /><span>{b.brand}</span></a>
          <div className="lg-links">
            <button onClick={() => scrollTo('recursos')}>Recursos</button>
            <button onClick={() => scrollTo('como')}>Como funciona</button>
            <button onClick={() => scrollTo('preco')}>Preço</button>
            <button onClick={() => scrollTo('faq')}>Dúvidas</button>
          </div>
          <Button variant="primary" size="sm" onClick={() => navigate('/entrar')}>Entrar</Button>
        </div>
      </nav>

      <header className="lg-hero" id="top">
        <div className="lg-in">
          <div className="lg-badge">Treinos · Peso corporal · Progresso</div>
          <h1>Seu treino virou um plano.<br />E o plano virou <em>resultado</em>.</h1>
          <p className="lg-sub">
            O {b.brand} monta sua semana, guia cada série com os pesos que você usou da última vez
            e mostra exatamente onde você está evoluindo — tudo no seu celular.
          </p>
          <div className="lg-ctas">
            <Button variant="primary" size="lg" icon="bolt" onClick={() => navigate('/entrar')}>Começar com {trial}</Button>
            <Button size="lg" onClick={() => scrollTo('recursos')}>Ver os recursos</Button>
          </div>
          <div className="lg-hero-meta">
            <span><Icon name="check" /> {preco}/mês depois do período grátis</span>
            <span><Icon name="check" /> Sem fidelidade — cancele quando quiser</span>
            <span><Icon name="check" /> Sem anúncios</span>
          </div>

          <div className="lg-shots">
            <Shot src="./screenshots/plan.png" alt="Planilha semanal" />
            <Shot src="./screenshots/workout.png" alt="Treino guiado" tilt />
            <Shot src="./screenshots/stats.png" alt="Estatísticas" />
          </div>
        </div>
      </header>

      <section className="lg-sec" id="recursos">
        <div className="lg-in">
          <h2>Tudo que o seu treino precisa <span className="lg-dim">— e nada que ele não precisa.</span></h2>
          <div className="lg-grid">
            {FEATURES.map(f => (
              <div className="lg-feat" key={f.t}>
                <div className="lg-feat-ic"><Icon name={f.icon} /></div>
                <h3>{f.t}</h3>
                <p>{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lg-sec lg-alt" id="como">
        <div className="lg-in">
          <h2>Do cadastro ao primeiro treino em cinco minutos</h2>
          <div className="lg-steps">
            <div className="lg-step">
              <div className="lg-step-n">1</div>
              <h3>Crie seu perfil</h3>
              <p>Nome e uma passkey — sua digital ou Face ID. Sem senha para decorar, sem e-mail para confirmar.</p>
            </div>
            <div className="lg-step">
              <div className="lg-step-n">2</div>
              <h3>Monte sua semana</h3>
              <p>Escolha os exercícios de cada dia entre 5.632 opções com demonstração animada, filtrando pelo equipamento que você tem.</p>
            </div>
            <div className="lg-step">
              <div className="lg-step-n">3</div>
              <h3>Treine e acompanhe</h3>
              <p>O app conduz a sessão, anota cada série e transforma tudo em gráficos, PRs e mapa muscular.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="lg-sec" id="preco">
        <div className="lg-in">
          <h2>Um preço, tudo incluso</h2>
          <p className="lg-sec-sub">Sem plano "pro" escondido, sem limite de treinos, sem cobrar por recurso básico.</p>
          <div className="lg-price">
            <div className="lg-price-tag">Plano mensal</div>
            <div className="lg-price-val"><strong>{preco}</strong><span>/mês</span></div>
            <ul className="lg-price-list">
              <li><Icon name="check" /> {b.trialDays > 0 ? `${b.trialDays} dias grátis para conhecer tudo` : 'Acesso completo desde o primeiro dia'}</li>
              <li><Icon name="check" /> Treinos, planilha, estatísticas e mapa muscular ilimitados</li>
              <li><Icon name="check" /> Sincroniza entre celular e computador</li>
              <li><Icon name="check" /> Importação de FitNotes, Strong e Hevy</li>
              <li><Icon name="check" /> Cancele quando quiser, sem multa</li>
            </ul>
            <Button variant="primary" size="lg" icon="bolt" onClick={() => navigate('/entrar')}>Criar meu perfil agora</Button>
            <div className="lg-price-note">Pagamento por Pix ou cartão · sem fidelidade</div>
          </div>
        </div>
      </section>

      <section className="lg-sec lg-alt" id="faq">
        <div className="lg-in lg-faq-in">
          <h2>Perguntas frequentes</h2>
          {FAQ.map(x => (
            <details className="lg-faq" key={x.q}>
              <summary>{x.q}</summary>
              <p>{x.a}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="lg-footer">
        <div className="lg-in lg-foot-in">
          <div className="lg-foot-brand">
            <Icon name="dumbbell" /><span>{b.brand}</span>
            <span className="lg-dim"> — treine com plano, evolua com dados.</span>
          </div>
          <div className="lg-foot-row">
            <span className="lg-dim">© {new Date().getFullYear()} {b.brand}. Todos os direitos reservados.</span>
            {/* Acesso do gestor ao painel separado — fica aqui de propósito: discreto, mas sempre visível no rodapé. */}
            <button className="lg-admin-btn" onClick={() => navigate('/painel')}>
              <Icon name="lock" /> Administração
            </button>
          </div>
        </div>
      </footer>
    </div>
  )
}
