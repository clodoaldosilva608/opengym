# Transformando o openGym em serviço por assinatura

Este fork adiciona uma camada comercial ao openGym: **landing page pública**, **cobrança
mensal** (R$ 14,90/mês por padrão), **painel de administração separado** e o **gate de
assinatura** na API. O app em si continua idêntico para quem tem acesso.

## O que foi adicionado

| Área | Onde | O que faz |
|---|---|---|
| Landing page | `/#/` (pública) | Apresenta o serviço, recursos, preço e FAQ. O botão **Administração** no rodapé leva ao painel. |
| Autenticação | `/#/entrar` | Página dedicada: entrar com passkey ou criar perfil (novo perfil = trial). |
| Assinatura | `/#/billing` | Estado do plano, abertura de cobrança Pix, "verificar acesso". Aparece sozinha quando o trial acaba. |
| Painel admin | `/#/painel` | **Separado do app**: login por usuário/senha (cookie `ogadmin`), visão geral, gestão de usuários (isentar, desativar, +30 dias) e aprovação de Pix. |
| API billing | `api/billing.js` | Estado de assinatura, cobranças, integração Mercado Pago, migração de perfis antigos. |
| API painel | `api/server.js` | Rotas `/api/panel/*` com autenticação dedicada (scrypt + rate limit + revogação de sessão). |

## Fluxo do assinante

1. Amigo abre a landing → **Entrar** → cria o perfil com passkey → entra com **trial de 7 dias** (configurável).
2. Vencido o trial, a API bloqueia os dados (HTTP 402) e o app mostra a tela de assinatura.
3. Pagamento:
   - **Pix manual** (`PIX_KEY` + `PIX_HOLDER` no `.env`): o app mostra a chave; o usuário paga e clica em "Já paguei"; no painel aparece **"Pix aguardando"** → botão **Aprovar** → +30 dias (`PERIOD_DAYS`) de acesso imediatamente.
   - **Mercado Pago** (`MERCADOPAGO_ACCESS_TOKEN`): o checkout é criado via API; quando o pagamento é aprovado, o webhook `/api/billing/webhook` confirma e libera o acesso sem intervenção. Configure `MP_WEBHOOK_URL` com o domínio público.
4. Amigos/contas de graça: no painel, **Isentar** marca o perfil como isento (nunca cobra). **Retirar isenção** volta a cobrar.

Perfis criados **antes** de ligar o faturamento ficam isentos automaticamente na primeira inicialização — o dono nunca é trancado. Isso é visível no painel e reversível.

## Segurança do painel

- Credenciais próprias (`ADMIN_USERNAME`/`ADMIN_PASSWORD`), hash scrypt, fora dos perfis de usuário.
- Cookie `ogadmin` independente do `gymsid`; logout do painel **invalida todos os tokens anteriores** do admin (contador de versão).
- Rate limit de 10 tentativas/10 min por usuário+IP no login.
- Sessão do painel dura 2 dias por padrão (`ADMIN_SESSION_DAYS`).

## Variáveis de ambiente (resumo)

Ver `.env.example`. Essenciais para o serviço:

```sh
ADMIN_USERNAME=dono
ADMIN_PASSWORD=troque-esta-senha
TRIAL_DAYS=7
PRICE_MONTHLY=14.90
PIX_KEY=seu-pix@email.com
PIX_HOLDER=Seu Nome
APP_BRAND=openGym
# opcional (automático):
# MERCADOPAGO_ACCESS_TOKEN=...
# MP_WEBHOOK_URL=https://seu-dominio.com/api/billing/webhook
```

## Deploy

Igual ao openGym original: `cp .env.example .env`, ajuste, `docker compose up -d --build`.
A landing fica em `https://seu-dominio.com/`, o app para assinantes abre depois de
**Entrar**, e o painel em `https://seu-dominio.com/#/painel`.

## Testes

```sh
cd api && npm test                     # inclui test/billing.test.js
node scripts/smoke-billing.mjs         # e2e: migração → trial vencido → 402 → Pix → aprovação → isenção
cd frontend && npm test                # vitest do frontend
```

## Conformidade (AGPL)

O código base é AGPL v3.0. **Ao oferecer como serviço a outras pessoas, você deve
disponibilizar o código-fonte desta versão modificada para os usuários do serviço**
(por exemplo, publicando este fork num repositório público). Mantenha `LICENSE` e
`NOTICE.md` no lugar. Uso pessoal/familiar não exige nada disso.
