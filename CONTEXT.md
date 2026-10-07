# CONTEXT.md — contexto do produto, decisões e estado atual

Atualizado em 07/10/2026 (licença concluída). Mantenha este arquivo em dia ao concluir cada etapa.

## O produto

Sistema de pedidos e PDV **base**, replicado e customizado por cliente (restaurantes primeiro;
depois rodízios, lojas de roupa e comércio em geral). Customizações (cardápio, marca etc.) são
feitas com ajuda do Claude. Requisitos: leve, rápido, boa UI/UX, responsivo e **funcionando offline**
numa rede local com celulares, impressoras e notebooks.

Modelo de negócio: **SaaS de R$ 150/mês** cobrado do estabelecimento.

Briefing técnico completo (revisões de arquitetura, segurança, LGPD, fiscal e jurídico):
https://claude.ai/code/artifact/46d57cf7-da31-4282-ae88-bf09c4342516

## Decisões já tomadas (não reabrir sem o usuário pedir)

| Tema | Decisão |
| :--- | :--- |
| Tema visual | 3 opções — Claro, Escuro, Usar cores do sistema — trocadas **só no painel do ADMIN** e aplicadas a todos os aparelhos. |
| Nota fiscal | NFC-e é autorizada pela **SEFAZ do estado** (não pela Receita). Motor: **ACBrMonitorPLUS local** (funciona offline/contingência; custo ~zero por cliente). API em nuvem só como alternativa futura. |
| Módulo fiscal | **Opcional**, desligado por padrão, toggle em **Gestão → Módulos**. Quem não emite pelo sistema (MEI, já tem PDV fiscal) deixa desligado. |
| Cobrança | Gateway: **Mercado Pago** (decisão do usuário, troca do Asaas). Assinatura mensal (preapproval) com link para o cliente autorizar; Pix Automático como principal **se** a assinatura do MP aceitar (validar no sandbox), cartão recorrente como alternativa; pagamento manual pela API admin. |
| Corte por falta de pagamento | **Bloqueia no 8º dia após o vencimento, mesmo offline** (licença assinada com validade embutida). |
| Taxa de serviço | Fora do valor da NFC-e (Lei 13.419). |
| Senhas | Nenhuma senha padrão; senha de fábrica de instalação antiga obriga troca. |

## Estado atual (branch `feat/p0-seguranca`)

Commits: `bc130d2` (P0), `03956f4` (módulo fiscal) e o commit da licença. 46 testes passando.

**Pronto (P0):** login por usuário e papéis; gestão de usuários; JWT por instalação; Socket.IO
autenticado; limite de tentativas; auditoria com hash encadeado; migrações versionadas com backup;
estoque transacional com movimentações; cancelamento lógico + PIN de supervisor; fila offline do
garçom; gaveta do caixa (fundo de troco, sangria, suprimento, conferência esperado × contado);
backup diário + restauração; logs em arquivo; dinheiro em centavos; tema claro/escuro/sistema com
contraste revisado; instalador Electron; CI no GitHub Actions.

**Pronto (P1, parte):** módulo fiscal NFC-e opcional (`src/fiscal/`): assistente, pendências, NCM
por produto, teste com a SEFAZ, emissão no fechamento de conta, contingência offline automática,
reenvio, cancelamento em 30 min, CPF na nota, tela Notas fiscais, motor de Simulação.

**Pendências conhecidas do fiscal:**
- Validar comandos/campos do ACBrMonitorPLUS real em homologação (só testado com servidor falso).
- Impressão automática do DANFE; inutilização de numeração após rejeição.
- Campos IBS/CBS da Reforma Tributária (CRT 3 desde 08/2026, rejeição suspensa; Simples em 01/2027).
- Tributos aproximados no cupom (Lei 12.741 / IBPT).

**Pronto (P1): licença e corte em 7 dias.**
- Central: `src/license/` (token Ed25519 verificado offline, impressão digital da máquina via
  MachineGuid, régua, anti-relógio-atrasado, avaliação de 7 dias em instalação nova ou
  atualizada), trava em abrir mesa/lançar pedido, faixa de aviso, aba **Gestão → Licença**
  (ativar, atualizar, buscar pelo celular no 4G, instalar arquivo). Módulo fiscal só liga se o
  plano tiver `fiscal`.
- Servidor de licenças em `license-server/` (Node + SQLite): ativação com código, emissão de
  licença, webhook do Mercado Pago (assinatura x-signature validada, pagamento consultado na API,
  idempotente, estorno, faturas de assinatura), criação da assinatura com link, API admin
  (clientes, pagamento manual, troca de máquina). Regra de ciclo: pagou em dia mantém o
  vencimento; pagou depois de bloqueado começa ciclo novo. Testado ponta a ponta com a central (`tests/license.test.ts`).
- A chave em `license-server/keys/` é de DESENVOLVIMENTO e é a que está embutida na central.
  Para produção: `npm run keys` no servidor de produção e trocar `EMBEDDED_PUBLIC_KEY`.

**Pendências da licença/cobrança:**
- Publicar o servidor de licenças (hospedagem + domínio HTTPS) e gerar a chave de produção.
- Mercado Pago: criar aplicação, configurar webhook (Pagamentos + Planos e assinaturas) e testar
  no sandbox: tópicos recebidos nas faturas e se a assinatura aceita Pix Automático.
- **NFS-e da mensalidade:** o Mercado Pago não emite nota. Emitir pelo Emissor Nacional ou
  integrar uma API de NFS-e ao servidor de licenças (disparada no pagamento aprovado).
- Lembretes D-3/D+1/D+3/D+5/D+7 por e-mail/WhatsApp: o MP não tem régua; hoje só os avisos na
  tela da central. Melhoria futura do servidor de licenças.

## Licença com corte em 7 dias — especificação acordada (IMPLEMENTADA)

Referência do que foi combinado (já implementado; ver "Pronto (P1)" acima):

1. **Servidor de licenças (nosso, na nuvem)** — ainda não existe; projeto separado. Recebe webhook
   do gateway (pagamento confirmado) → atualiza `paidUntil` → emite token e dispara a **NFS-e
   Nacional** da mensalidade (obrigatória para ME/EPP do Simples desde 01/11/2026).
2. **Token de licença Ed25519** assinado: `{clientId, plan, features, maxDevices, paidUntil,
   validUntil, hwFingerprint, issuedAt}`; `validUntil = vencimento + 7 dias`. Chave pública
   embutida no app; token preso à máquina.
3. **Na central (offline):** valida a assinatura localmente e compara a data com `validUntil`.
   Com internet, busca token novo no boot e a cada hora.
4. **Relógio voltado:** guardar a maior data já vista (banco + arquivo com HMAC) e o `created_at`
   do último pedido; recuo de mais de algumas horas = tratar como expirado. Com internet, usar a
   hora do nosso servidor.
5. **Renovação 100% offline:** a tela de licença no celular do ADMIN baixa o token pelo 4G e
   entrega à central pela LAN; alternativa: arquivo de licença (pendrive/WhatsApp).
6. **Régua:** D-3 aviso; D0 débito; D+1 a D+7 sistema normal com faixa de aviso (Admin e Caixa)
   contando os dias; **D+8 bloqueia abrir mesa e lançar pedido novo**.
7. **Sempre liberado, mesmo bloqueado:** fechar contas já abertas, transmitir NFC-e em
   contingência, exportar XMLs e dados, tela de pagamento/renovação. (Bloquear isso gera risco
   jurídico: multa fiscal repassada e LGPD.)
8. `features` do token liga/desliga módulos (ex.: fiscal) por plano.
9. Nunca armazenar número de cartão/CVV (só token do gateway).

## Fora do código (responsabilidade dos sócios — ver briefing)

LTDA/SLU no Simples (CNAE 6203-1/00 + 6202-3/00, Fator R ≥ 28%); cessão dos direitos do código
para a empresa; contrato SaaS + DPA (LGPD) + termos + política de privacidade, prevendo o corte em
7 dias; certificado de assinatura de código para o instalador (sem ele o Windows mostra
"editor desconhecido"); credenciamento de software house onde a UF exigir (ex.: SC).

## Próximos passos (roadmap restante do briefing)

P1: impressão ESC/POS (comandas por setor, DANFE, gaveta); configuração por cliente
(`tenant.json`, marca, feature flags por segmento); atualização automática com canais;
LGPD no produto (relatório/anonimização por CPF, retenção); conformidade do cardápio
(alérgenos, alerta de bebida alcoólica, couvert opcional); HTTPS/PWA na LAN.
P2: relatórios com ML; módulos rodízio/varejo/delivery; portal na nuvem; performance e limpeza.
