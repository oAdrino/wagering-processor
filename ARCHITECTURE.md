# ARCHITECTURE — Wagering Processor

## Objetivo e prioridades

Processar operações financeiras recebidas de múltiplos provedores com `at-least-once delivery`, reordenação e múltiplos processos, sem duplicar créditos ou débitos e sem permitir saldo negativo. Prioridades: precisão, idempotência persistente, atomicidade, auditabilidade e recuperação de falhas.

## Domínio e limites

- `Money`: Value Object imutável; armazenamento interno em `bigint` de centavos e fronteiras como string decimal fixa de duas casas (`"25.00"`). Evita ponto flutuante sem exigir biblioteca Decimal, opção permitida pelo esqueleto de referência. A API restringe operações a `BRL`, mas o domínio diferencia moedas.
- `Wallet`: Aggregate Root, encapsula saldo e versão. `open()` valida abertura e `rehydrate()` recupera estado. Saldo não pode ficar negativo e versão só aumenta quando muda.
- `WagerTransaction`: máquina de estados `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`; os três últimos são terminais. `OPENING` interno, não exposto na API/fila.
- `WalletLedgerEntry`: lançamento imutável; `balanceBefore ± money = balanceAfter`. Sem saldo alterado não há lançamento (`LOSS`, `REJECTED`).
- `InboxMessage`, `OutboxMessage` e `IntegrationEvent<T>`: modelos de domínio e serialização estável. Os triggers escrevem envelopes equivalentes com `eventId`, `eventType`, `version`, `data` e rastreabilidade.

## Persistência

PostgreSQL 17 em Docker Compose; MikroORM 7 com `EntitySchema` na infraestrutura, mantendo o domínio sem decorators. `numeric(38,2)` preserva exatidão monetária. Migrations versionadas com `up()` e `down()`. Banco aplica checks de não-negatividade, aritmética, versão, chaves estrangeiras e índices exclusivos. Trigger `trg_wallet_ledger_immutable` impede `UPDATE`, `DELETE` e `TRUNCATE` do ledger em operações SQL comuns. O `schemaGenerator.ignoreTriggers` e `ignoreRoutines` evita que o MikroORM tente removê-los.

## Concorrência

Unidade de concorrência: `walletId`. `em.transactional()` com `PESSIMISTIC_WRITE` obtém `SELECT FOR UPDATE` da carteira; consultas de idempotência e referências são rechecadas depois do lock. Não existe lock global. Constraints do banco garantem saldo não negativo e unicidade: `(provider_id,idempotency_key)`, `(provider_id,external_transaction_id)` e o índice parcial para reversões. Outbox e Ledger não dependem de garantia FIFO para consistência.

## Idempotência

Header `Idempotency-Key` obrigatório na API, indexado por provedor; `payloadHash` é SHA-256 de um JSON com campos de negócio em ordem estável (header e metadados de transporte não fazem parte). Reenvio idêntico devolve mesmo `transactionId`, status e `resultBalanceAmount` persistido; payload divergente é HTTP 409. Inbox deduplica por `(consumer_name,message_id)` em `inbox_messages`; hash da mensagem de transporte detecta redelivery divergente. Inbox é inserida no `em.transactional()` do caso de uso, inclusive em replays. Reentrega após commit e antes de ack é segura.

## Regras de operação

- `BET`: débito se há saldo; caso contrário `REJECTED/INSUFFICIENT_FUNDS`.
- `WIN`: crédito; referência de BET é opcional.
- `LOSS`: `PROCESSED` sem ledger e sem incremento de versão.
- `REFUND`: crédito que reverte uma BET processada da mesma carteira, provedor, jogador, moeda e rodada; valor igual.
- `ROLLBACK`: movimento inverso de BET/WIN/REFUND. Reversão que retiraria saldo não disponível é rejeitada com código próprio.
- `PENDING_REFERENCE`: worker agendado verifica referência ausente; até oito tentativas ou 30 min, com backoff exponencial (5s a 5 min). Lock de wallet e rechecagem de status garantem segurança entre workers concorrentes.

## SQS / Inbox / Outbox

MiniStack simula SQS (endpoint `http://127.0.0.1:4566`). Entrada em `wager-transactions.fifo`, DLQ FIFO com `maxReceiveCount=5`, saída em `wager-events.fifo`. Requer `bun run infra:sqs` para provisionamento local. `SQS_ENABLED=1` habilita consumidores/publishers; `0` permite isolar testes HTTP.

Os eventos **são enfileirados no PostgreSQL por triggers** associados a inserções/alterações de status de `wager_transactions` e inserções de `wallet_ledger_entries`. Esses triggers executam na **mesma transação SQL** que o débito/crédito e não dependem de chamada HTTP, portanto também cobrem o worker de referências. Eventos mínimos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`. `WalletBalanceChanged` só é gerado por inserção no ledger (não para LOSS/REJECTED).

O publisher faz `SELECT ... FOR UPDATE SKIP LOCKED` para concorrer com outros publishers; o envio SQS ocorre **depois do commit financeiro**, com evento já persistido na Outbox. Após publicação, `published_at` é atualizado. Se cair entre envio e atualização, o evento poderá ser republicado — contrato **at-least-once**, com `eventId` estável e `MessageDeduplicationId` igual ao `eventId`. A duplicação após a janela de deduplicação SQS ainda pode acontecer: a aplicação consumidora deve deduplicar pelo `eventId` em banco.

O consumer SQS reutiliza `ProcessBetUseCase` e `ProcessOtherWagerUseCase` e usa `Inbox` persistente. Em erro não faz ack e altera `VisibilityTimeout` com backoff; a RedrivePolicy nativa move para DLQ. Em SIGTERM, shutdown hooks aguardam o lote em andamento e devolvem visibilidade de mensagens ainda não iniciadas.

## API e observabilidade

- Consultas por wallet e transação, ledger paginado por cursor `(created_at,id)` estável e opaco.
- Reconciliação faz leitura com lock compartilhado e soma os lançamentos; divergências são sinalizadas, sem correção silenciosa.
- `GET /health/live`: processo vivo, sem dependências.
- `GET /health/ready`: verifica PostgreSQL e SQS, retorna 503 se indisponíveis.
- `GET /metrics`: transações por status, total persistido na Inbox, pendências/lag/retries da Outbox.
- Logs de falhas de workers em JSON, sem corpo financeiro completo. A observabilidade atual é uma versão básica; métricas de p50/p95/p99, lock conflicts, DLQ e tracing distribuído ainda podem ser ampliadas.

## Autenticação

O README do desafio explicitamente permite não implementar autenticação, desde que a decisão seja documentada. Para o timebox, esta implementação não instala IdP nem cria tabela própria de senhas. `ProviderAuthGuard` é um ponto de extensão **no-op explicitamente identificado**, aplicado às rotas de negócio; não fornece proteção real. Em produção, adicionaríamos um `ProviderIdentityPort` + guard OIDC com Keycloak/Zitadel, validação de claims/tenant/provider e autorização de API. Health permanece público e mensagens SQS são tratadas como canal interno confiável, sujeito a validações do payload.

## Trade-offs e limites conhecidos

1. **Dinheiro:** `bigint` em centavos resolve valores de escala fixa 2, mas cálculos de taxa/porcentagem com escala variável exigiriam regras próprias ou `Decimal`.
2. **Migrations:** os triggers são geridos manualmente (não por entidades MikroORM); novas migrations devem ser revisadas antes de rodar.
3. **Outbox:** triggers SQL garantem persistência atômica mesmo quando o worker não chama serviço de eventos. Há acoplamento explícito entre banco e formato de eventos (versão 1). Mudanças de schema devem manter compatibilidade.
4. **Mensageria:** processamento é at-least-once; não é possível prometer exactly-once entre PostgreSQL e SQS. Publicações repetidas são toleradas por contrato.
5. **Worker SQS:** visibilidade padrão de 45 segundos; tarefas que ultrapassem esse tempo exigem heartbeats de visibilidade. DLQ ocorre após cinco recebimentos falhos, inclusive payloads inválidos.
6. **Operação:** em ambiente real, configurar banco/filas com credenciais seguras, observabilidade centralizada e política de retenção/backup. Usuários ainda não são autenticados — deployment público não é apropriado.
7. **Testes:** os testes Bun e de PostgreSQL/SQS/múltiplos processos devem ser executados no ambiente Docker do candidato. Há cobertura de corridas comuns e idempotência, mas cenários determinísticos de crash pós-commit/pré-ack e pós-publish/pré-update exigem testes de falha/kill adicionais. Não declarar testes que não foram executados como aprovados.

## Como reproduzir e avaliar

Consulte o README para `bun install`, `docker compose up -d`, `bun run infra:sqs`, `migration:up`, `bun test src/domain`, testes com `RUN_DB_TESTS=1`, `RUN_SQS_TESTS=1` e `bun run test:multi`. Inspecione `wallet_ledger_entries` e `outbox_messages` para verificar a atomicidade após cada operação.
