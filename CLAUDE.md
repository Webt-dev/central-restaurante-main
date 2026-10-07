# CLAUDE.md — instruções para trabalhar neste repositório

Leia também o **CONTEXT.md**: lá estão o negócio, as decisões já tomadas, o que está pronto e o
próximo passo. Este arquivo trata de *como* trabalhar no código. Se algo aqui conflitar com o
`INFORMACOES_DO_PROJETO_E_GUIA_TECNICO.txt` (antigo), vale este arquivo e o CONTEXT.md.

Responda ao usuário em **português do Brasil**, em linguagem simples (o dono do produto não é
programador). Comentários de código também em português, explicando o *porquê*.

## Stack

- **Backend:** Node 22 + TypeScript (ESM, `module: nodenext`), Express 5, better-sqlite3 (WAL),
  Socket.IO, zod. Código em `src/`, saída em `dist/`.
- **Frontend:** React 19 + Vite + TS em `frontend/src` (Dexie para IndexedDB, lucide-react).
- **Desktop:** Electron (`main.js`) roda o servidor num `utilityProcess` separado da janela;
  instalador NSIS via electron-builder.
- Tudo roda **na rede local** do estabelecimento (offline-first). Celulares acessam `http://IP:3000`.

## Comandos

```bash
npm run dev                 # backend com tsx watch (porta 3000)
npm --prefix frontend run dev   # frontend Vite (5173, com proxy para 3000)
npm test                    # node:test + tsx, tests/*.test.ts (banco temporário)
npm run typecheck           # tsc --noEmit do backend
npx tsc -b --noEmit         # (dentro de frontend/) typecheck do frontend
npm run build:all           # build frontend + backend
npm run dist:win            # instalador em release/ (recompila better-sqlite3 p/ Electron e depois volta p/ Node)
npm run restore             # lista/restaura backups (com o sistema fechado)
```

Antes de dizer que terminou: `npm run typecheck`, `npm test` e typecheck do frontend precisam passar.

## Regras do código (não quebrar)

1. **Migrações:** esquema só muda acrescentando uma entrada no fim de `MIGRATIONS` em
   `src/config/migrations.ts` (controlado por `PRAGMA user_version`). Nunca editar uma migração
   já distribuída. Há backup automático antes de migrar.
2. **Seed:** cardápio/estoque de demonstração só no primeiro boot. Nunca `INSERT OR REPLACE`
   em dados do cliente.
3. **Segurança:**
   - Toda rota nova usa `authenticate` + `authorize([...])` (ADMIN sempre passa).
   - Não existe senha padrão; o 1º ADMIN é criado em `POST /api/auth/setup`.
   - O segredo JWT é por instalação (`src/config/secrets.ts`); nunca colocar segredo no código.
   - Socket.IO só conecta com token; salas são definidas pelo papel no servidor.
4. **Auditoria:** ação sensível (preço, estoque, usuário, cancelamento, caixa, fiscal, config)
   chama `auditRequest(...)` (`src/services/AuditService.ts`). A tabela `audit_log` é
   append-only com hash encadeado.
5. **Dinheiro:** contas em centavos com `src/utils/money.ts` (`toCents`, `toReais`, `lineTotal`,
   `sumReais`, `percentOf`). Nada de somar reais em ponto flutuante.
6. **Estoque:** toda alteração de saldo passa por `InventoryRepository` (registra em
   `inventory_movements`). Pedido é criado numa transação única. Item nunca é apagado:
   cancelamento lógico (`status = 'CANCELLED'` + quem/quando/motivo) com estorno.
   Item já em preparo só é alterado por ADMIN ou com **PIN de supervisor**.
7. **Erros:** use `HttpError(status, mensagem, code?)` (`src/utils/httpError.ts`). Mensagens ao
   usuário em português. Erros do SQLite viram 500 genérico no `errorHandler`.
8. **Validação:** corpo das rotas validado com zod (`validateBody`).
9. **Fiscal:** o caixa nunca fala com a SEFAZ diretamente; usa `src/fiscal/FiscalService.ts`, que
   chama um `FiscalProvider`. O módulo é opcional e vem desligado. Produto sem NCM bloqueia a
   emissão (sem NCM "chutado").
10. **Frontend:**
    - Cores só por tokens CSS em `frontend/src/index.css` (tema claro em `:root`, escuro em
      `[data-theme="dark"]` e `system` via media query). Não usar hex fixo em componentes.
    - O tema é escolhido só pelo ADMIN (Claro / Escuro / Usar cores do sistema).
    - Sessão em `services/session.ts`; telas por papel em `SCREENS_BY_ROLE`.
    - Pedido do garçom passa pela fila offline `services/outbox.ts` (idempotente por `offline_sync_id`).
11. **Logs:** `src/utils/logger.ts` grava o console em arquivo e mascara senha/token/CSC.
    Não logar dados pessoais (CPF etc.).
12. Não comitar: banco (`*.sqlite`, `*.db`), `.jwt-secret`, `backups/`, `release/`,
    `.claude/launch.json`.

## Cuidados no ambiente (Windows do usuário)

- O caminho do projeto tem espaço ("Triozada Stuff"): node-gyp avisa; o electron-builder usa
  binário pré-compilado. Depois de `electron-builder`, rode `npm rebuild better-sqlite3`
  (o `dist:win` já faz).
- **Nunca** encerrar processos genéricos (ex.: `taskkill /IM node.exe`): mate só o PID do teste.
- Testes manuais no navegador: use `.claude/launch.json` (config `central-teste`, porta 3998,
  `DB_PATH` e `DOCUMENTS_DIR` na pasta temporária). Nunca rode contra o `database.sqlite` real
  do usuário sem backup, e nunca deixe relatório de teste na Área de Trabalho dele.
- `DOCUMENTS_DIR` muda a pasta de cupons/relatórios (padrão: Área de Trabalho).
- Commits só quando o usuário pedir; trabalhe em branch (hoje `feat/p0-seguranca`).
