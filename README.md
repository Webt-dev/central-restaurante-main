# 🍽️ Central Restaurante - Sistema Completo (Backend & Frontend)

Sistema robusto, moderno e completo para gestão centralizada de restaurantes com suporte a múltiplas telas em tempo real (Caixa POS, Garçom Mobile, Cozinha KDS, Bar e Relatórios/Estoque), banco de dados SQLite atômico, WebSockets (Socket.IO), design 100% responsivo e sincronização offline.

---

## ⚡ Lista Completa de Funcionalidades

### ⚙️ 1. Funcionalidades do Backend (API REST & Realtime)

- **🔐 Autenticação & Segurança (RBAC)**
  - Autenticação via Login com token JWT Bearer.
  - Criptografia de senhas com `scryptSync` + `salt` aleatório de 16 bytes.
  - Perfis de acesso restritos (RBAC): `ADMIN`, `CASHIER` (Caixa), `WAITER` (Garçom) e `KITCHEN` (Cozinha/Bar).
  - Atribuição e rastreamento automático do operador da requisição.

- **🪑 Gerenciamento de Mesas**
  - Listagem e atualização de status em tempo real (`FREE` 🟢, `OCCUPIED` 🔴, `PAYMENT_PENDING` 🟡).
  - Cálculo automático do extrato consolidado por mesa.

- **🍔 Cardápio & Ficha Técnica**
  - Cadastro de produtos com foto, preço, descrição e 6 categorias (*Lanches*, *Pratos Principais*, *Porções*, *Bebidas*, *Drinks do Bar*, *Sobremesas*).
  - Mapeamento de receitas e gramaturas de insumos em `menu_item_ingredients`.
  - Abatimento físico automático do estoque com base nas gramaturas dos pratos consumidos.

- **📦 Gestão de Estoque de Insumos**
  - Controle em unidades (`un`), gramas (`g`), quilos (`kg`), litros (`l`) e doses (`dose`).
  - Alerta automático de insumos com saldo crítico (`quantity <= min_quantity`).

- **📝 Módulo de Pedidos & Separação Automática**
  - Separação automática de itens enviados para a Cozinha (comida) e para o Bar (bebidas/drinks).
  - Endpoint de sincronização em lote (`POST /api/orders/sync-batch`) para comandas offline registradas pelo garçom em áreas sem sinal.

- **🍳 Cozinha & 🍸 Bar (KDS - Kitchen Display System)**
  - Fila de produção em tempo real via WebSockets (Socket.IO).
  - Atualização por item ou botão global por mesa (`PENDING` ➡️ `PREPARING` ➡️ `READY` ➡️ `DELIVERED`).

- **💰 Caixa Central (POS) & Pagamentos**
  - Suporte a Pagamento Único ou Pagamento Fracionado/Dividido em múltiplas formas.
  - Formas de pagamento aceitas: PIX, Cartão de Crédito, Cartão de Débito e Dinheiro.
  - Calculadora de troco automática para pagamentos em dinheiro.
  - Opção interativa para inclusão da Taxa de Serviço (10% Garçom).
  - Emissão de Cupom Fiscal térmico em formato `.TXT` salvo na pasta `comprovantes_mesas/`.
  - Reimpressão de cupons fiscaes de comandas encerradas.

- **🔴 Encerramento de Expediente Diário & Business Analytics**
  - Trava de encerramento do dia com modal de confirmação de dupla checagem.
  - Cálculo de estatísticas e rankings: Prato mais vendido, Bebida mais vendida, Mesa top faturamento e Método de pagamento mais rentável.
  - Baixa física real no banco de dados SQLite de todos os insumos consumidos pelas receitas no dia.
  - Geração do Documento Oficial em `.TXT` do relatório do expediente na pasta `relatorios_expediente/`.
  - Discriminação dos 3 totalizadores: Faturamento Total Geral (com 10%), Total Só Sem os 10% (consumo) e Total Só 10% (taxas de serviço).

- **📡 Comunicação Realtime & Rede Local**
  - Disparo instantâneo de eventos Socket.IO: `order:created`, `order:status_changed`, `table:status_changed`, `payment:processed`.
  - Configuração de binding `0.0.0.0` para acesso simultâneo via celulares e TVs na rede Wi-Fi local.

---

### 📱 2. Funcionalidades do Frontend (Interface Web & Mobile)

- **📱 Design Responsivo & Mobile-First**
  - Interface do garçom 100% otimizada para smartphones (zero rolagem/estouro lateral).
  - Proporções adaptadas para Smart TVs na Cozinha e no Bar.

- **👨‍🍳 Tela do Garçom (`/garcom`)**
  - Grid de mesas com status visual e toque fácil.
  - Busca rápida de produtos e navegação fluida por abas de categorias.
  - Lançamento de observações por item (ex: "Sem cebola").
  - Barra flutuante mobile de carrinho para envio rápido à produção.
  - Exibição discriminada dos valores: Subtotal (sem 10%), Sugestão Garçom (10%) e Total Estimado (com 10%).

- **🍳 Tela da Cozinha (`/cozinha`) & 🍸 Tela do Bar (`/bar`)**
  - Painéis KDS dedicados e separados para pedidos de comida (Cozinha) e bebidas (Bar).
  - Botão de ação rápida por mesa ("Pronto para Todos da Mesa") e controles por item individual.
  - Atualização instantânea na tela sem necessidade de recarregar a página.

- **💳 Tela do Caixa POS (`/caixa`)**
  - Grid de mesas ocupadas para fechamento de conta.
  - Extrato detalhado com alternância entre visão por itens e visão por linha do tempo dos horários lançados.
  - Checkbox interativo `[x] Incluir Taxa de Serviço (10% Garçom)`.
  - Discriminação explícita dos valores: Subtotal sem 10%, Taxa de Serviço 10% e Total Final com 10%.
  - Calculadora de troco em dinheiro e divisão de pagamento em múltiplas formas.
  - Modal de conferência e verificação de segurança dos itens e valores antes da confirmação.
  - Visualizador e simulador de impressão do Cupom Fiscal em texto térmico `.TXT`.
  - Histórico de comandas fechadas hoje com botão para reimpressão de cupom.

- **📊 Tela de Relatórios & Estoque (`/relatorios`)**
  - Botão vermelho destacado **"🔴 ENCERRAR EXPEDIENTE DO DIA"** com modal de dupla confirmação.
  - Dashboard de Métricas com os 3 totalizadores destacados em cards: Faturamento Total (com 10%), Total Sem 10% e Total Só 10%.
  - Painel gerencial com destaques e rankings (Prato Top, Bebida Top, Mesa Top, Pagamento Top).
  - Tabela visual de insumos do estoque com barras de progresso e alertas de nível crítico.
  - Visualizador integrado do documento em `.TXT` do relatório oficial do expediente.
  - Histórico detalhado de comandas encerradas com formatação de datas no padrão brasileiro (`DD/MM/YYYY` e `DD/MM/YYYY HH:MM`).

---

## 📐 Arquitetura do Projeto

O sistema foi desenvolvido utilizando a **Arquitetura em Camadas (Layered Architecture)** no backend e React com componentes funcionais no frontend:

```text
central-restaurante/
├── src/                        # Backend Node.js + Express + SQLite + Socket.IO
│   ├── config/                 # Configurações do ambiente, SQLite WAL e Seed (37+ itens)
│   ├── controllers/            # Handlers HTTP de requisição/resposta
│   ├── middlewares/           # Autenticação JWT, autorização RBAC e validação Zod
│   ├── models/                 # Interfaces e Tipos TypeScript centralizados
│   ├── repositories/          # Queries SQL atômicas, relatório e baixa por receita
│   ├── routes/                 # Definição e roteamento das APIs RESTful
│   ├── services/               # Regras de negócio e transações de pagamento
│   ├── sockets/                # Gerenciador de WebSockets (Socket.IO)
│   ├── utils/                  # Geradores de cupom, relatório TXT, datas BR e crypto
│   └── server.ts               # Servidor Express + Socket.IO (0.0.0.0)
│
├── frontend/                   # Frontend React + TypeScript + Vite + Vanilla CSS
│   ├── src/
│   │   ├── components/         # Interfaces (Waiter, Kitchen, Bar, Cashier, Reports, Login)
│   │   ├── services/           # APIs HTTP (fetch) e cliente Socket.IO
│   │   ├── utils/              # Formatação de datas em padrão brasileiro (DD/MM/YYYY)
│   │   ├── types.ts            # Tipagens TypeScript da aplicação cliente
│   │   └── index.css           # Design System responsivo sem overflow lateral
│   └── vite.config.ts          # Configuração de host 0.0.0.0 para acesso via celular
│
├── comprovantes_mesas/         # Armazenamento dos Cupons Fiscais térmicos em .TXT
└── relatorios_expediente/      # Armazenamento dos Relatórios Oficiais do Expediente em .TXT
```

---

## 🛠️ Tecnologias Utilizadas

- **Backend**: Node.js, TypeScript, Express 5, SQLite (`better-sqlite3`), Socket.IO, Zod.
- **Frontend**: React 18, TypeScript, Vite, Vanilla CSS (Design System com variáveis CSS), Lucide React Icons.
- **Formato de Saída**: Cupons fiscais e relatórios gerados nativamente em arquivos `.TXT`.

---

## ⚡ Como Executar o Projeto

### 1. Instalar dependências e iniciar o Backend:
```bash
npm install
npm run dev
```
*O backend estará rodando em: `http://localhost:3000` (e `http://<SEU_IP_LOCAL>:3000`)*

### 2. Iniciar o Frontend:
```bash
cd frontend
npm install
npm run dev
```
*O frontend estará rodando em: `http://localhost:5173` (e `http://<SEU_IP_LOCAL>:5173`)*

---

## 🔑 Credenciais Padrão (Seed Inicial)

O sistema popula automaticamente o banco de dados inicial na primeira execução:

| Função | Usuário | Senha |
| :--- | :--- | :--- |
| **Administrador** | `admin` | `admin123` |
| **Caixa** | `caixa` | `caixa123` |
| **Garçom** | `garcom` | `garcom123` |
| **Cozinha / Bar** | `cozinha` | `cozinha123` |

---

## 📄 Licença

Este projeto está sob a licença [ISC](LICENSE).
