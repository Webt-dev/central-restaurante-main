# Servidor de licenças — Central Restaurante

Serviço **nosso**, na nuvem. Recebe a confirmação de pagamento do **Mercado Pago**, guarda até
quando cada cliente pagou e emite a **licença assinada** que a central do restaurante confere
sozinha, mesmo sem internet. Projeto separado do sistema do restaurante: publique em qualquer
hospedagem Node 22 (Railway, Render, Fly.io, VPS…) **atrás de HTTPS**.

## Como funciona

1. Cadastramos o cliente aqui (`POST /admin/clients`) → recebemos o **código do cliente** e o
   **código de ativação** (mostrado uma única vez).
2. No restaurante, o administrador ativa em **Gestão → Licença** com esses dois códigos.
3. Criamos a assinatura mensal no Mercado Pago (`POST /admin/clients/:id/subscription`) e
   enviamos ao cliente o link devolvido, para ele autorizar a cobrança recorrente.
4. A cada cobrança aprovada o Mercado Pago chama `POST /v1/webhooks/mercadopago`; o servidor
   confere a assinatura do aviso, consulta o pagamento na API e estende a licença em 1 mês.
   Pagou em dia (ou dentro da carência): mantém o ciclo. Pagou depois de bloqueado: ciclo
   novo a partir do pagamento. Estorno/chargeback faz recuar.
5. A central busca a licença atualizada a cada hora. A licença vale até o vencimento
   **+ 7 dias de carência**; depois disso a central bloqueia novos pedidos sozinha.

## Configuração

```bash
npm install
npm run keys          # gera keys/private.pem (fica SÓ aqui) e imprime a chave pública
```

Cole a chave pública impressa em `src/license/token.ts` da central (`EMBEDDED_PUBLIC_KEY`) e
gere um novo instalador. **Trocar o par de chaves invalida todas as licenças já emitidas.**
A chave em `keys/` hoje é de desenvolvimento: gere a de produção no servidor de produção.

| Variável | Uso |
| :--- | :--- |
| `PORT` | Porta HTTP (padrão 8080) |
| `DB_FILE` | Banco SQLite (padrão `./data/licenses.sqlite`) — faça backup |
| `LICENSE_PRIVATE_KEY` ou `LICENSE_PRIVATE_KEY_FILE` | Chave privada Ed25519 (padrão `./keys/private.pem`) |
| `ADMIN_API_KEY` | Chave da API `/admin` (mínimo 32 caracteres) |
| `MP_ACCESS_TOKEN` | Access token da aplicação no Mercado Pago (use o de teste no sandbox) |
| `MP_WEBHOOK_SECRET` | "Assinatura secreta" do webhook (Suas integrações → Webhooks) |
| `MP_BACK_URL` | Página para onde o cliente volta depois de autorizar a assinatura |

```bash
npm start
```

## Mercado Pago (passo a passo)

1. Em **Suas integrações**, crie uma aplicação e copie o **access token** (`MP_ACCESS_TOKEN`).
   Comece com as credenciais de **teste** e usuários de teste.
2. Em **Webhooks → Configurar notificações**, cadastre `https://SEU-DOMINIO/v1/webhooks/mercadopago`,
   marque os eventos **Pagamentos** e **Planos e assinaturas** (faturas de assinatura) e copie
   a **assinatura secreta** (`MP_WEBHOOK_SECRET`).
3. Para cada cliente: `POST /admin/clients/:id/subscription` com `{ "payer_email": "...", "amount": 150 }`
   e envie o `link` retornado. A assinatura usa `external_reference = código do cliente`.
4. **Validar no sandbox antes de produção:**
   - quais tópicos chegam para as cobranças da assinatura na sua conta (`payment` e/ou
     `subscription_authorized_payment` — o servidor trata os dois);
   - se a assinatura aceita **Pix Automático** ou só cartão (a documentação lista Pix entre os
     meios das assinaturas, sem detalhar). Se não aceitar, Pix fica para o pagamento manual.
5. **NFS-e da mensalidade:** o Mercado Pago não emite nota; este servidor emite sozinho pela
   **Focus NFe** (ver seção abaixo).
6. **Lembretes de cobrança** (D-3, D+1, D+3, D+5, D+7): o Mercado Pago não tem régua de
   WhatsApp/e-mail como alguns gateways; a central já mostra os avisos na tela. Lembretes por
   e-mail/WhatsApp ficam como melhoria futura deste servidor.

## NFS-e automática (Focus NFe)

Cada pagamento aprovado (Mercado Pago ou manual com valor > 0) gera uma NFS-e Nacional da
mensalidade, com o cliente como tomador (CNPJ/CPF do campo `document`). A nota não atrasa a
liberação da licença: vai para uma fila, é enviada à Focus e uma rotina consulta a cada 2 minutos
até ficar **AUTORIZADA** ou **ERRO**.

1. Crie a conta na Focus NFe, cadastre a nossa empresa e envie o **certificado A1** dela no painel.
2. Com o contador, defina o **código de tributação nacional** do serviço (6 dígitos), a opção do
   Simples e confira se o município já está no padrão nacional.
3. Configure as variáveis e comece em `NFSE_AMBIENTE=homologacao`:

| Variável | Uso |
| :--- | :--- |
| `NFSE_FOCUS_TOKEN` | Token da empresa no painel da Focus (sem ele, não emite nota) |
| `NFSE_AMBIENTE` | `homologacao` (padrão) ou `producao` |
| `NFSE_CNPJ_PRESTADOR` | CNPJ da nossa empresa |
| `NFSE_CODIGO_MUNICIPIO` | Código IBGE (7 dígitos) do município da empresa |
| `NFSE_CODIGO_TRIBUTACAO` | Código de tributação nacional do serviço (6 dígitos) |
| `NFSE_OPCAO_SIMPLES` | 1 não optante, 2 MEI, 3 ME/EPP (padrão 3) |
| `NFSE_TRIBUTACAO_ISS` | Padrão 1 (operação tributável) |
| `NFSE_SERIE` / `NFSE_DESCRICAO` | Série da DPS e texto do serviço na nota |

- Nota com **ERRO**: corrija o cadastro e use `POST /admin/invoices/:id/retry` (gera nova
  referência e novo número de DPS).
- Pagamento estornado com nota autorizada: a nota fica **CANCELAR** — cancele no painel da Focus
  ou no Emissor Nacional (o cancelamento automático ainda não foi implementado).

## API administrativa (cabeçalho `x-api-key`)

| Rota | Para quê |
| :--- | :--- |
| `GET /admin/clients` | Lista clientes, vencimento e computadores ativados |
| `POST /admin/clients` | Cria cliente: `{ name, plan, features: ["fiscal"], max_devices, paid_until? }` |
| `PATCH /admin/clients/:id` | Muda plano, módulos, limite de computadores, `status: CANCELLED` |
| `POST /admin/clients/:id/subscription` | Cria a assinatura mensal no Mercado Pago e devolve o link para o cliente |
| `POST /admin/clients/:id/payments` | Pagamento fora do gateway: `{ amount, months, due_date?, note }` |
| `POST /admin/clients/:id/activation-code` | Gera novo código de ativação |
| `DELETE /admin/clients/:id/devices/:hw` | Libera a vaga de um computador (troca de máquina) |
| `GET /admin/invoices?status=` | NFS-e das mensalidades (PENDENTE, PROCESSANDO, AUTORIZADA, ERRO, CANCELAR) |
| `POST /admin/invoices/:id/retry` | Reenvia uma NFS-e com erro ou presa em processamento |

Rotas públicas: `POST /v1/activate`, `GET /v1/licenses/:clientId?hw=` (CORS liberado — usada
pelo celular do administrador quando a central está sem internet), `GET /health`.

## Arquivo de licença (renovação manual)

`GET /v1/licenses/:clientId?hw=<identificação do computador>` devolve `{ token }`. Salve o
`token` num arquivo `.txt` e envie ao cliente: ele cola em **Gestão → Licença → Instalar licença**.
A identificação do computador aparece nessa mesma tela.

Testes: os testes de integração ficam na central (`tests/license.test.ts`), que sobe este
servidor em memória (com uma API do Mercado Pago falsa) e testa ativação, régua, webhook
assinado, fatura de assinatura, estorno, ciclo de cobrança e bloqueio.
