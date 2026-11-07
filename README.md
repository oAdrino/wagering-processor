# Wagering Processor

Serviço financeiro distribuído em **Bun 1.x + TypeScript strict + NestJS + MikroORM + PostgreSQL + SQS (MiniStack)** para processar `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` com dinheiro exato, ledger auditável, idempotência e processamento assíncrono.


Enunciado original: [`docs/CHALLENGE.md`](docs/CHALLENGE.md). Decisões técnicas, arquitetura e limitações: [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Requisitos

- Bun 1.x, Docker Desktop com WSL2/virtualização habilitados.
- Git (para clonar e versionar).
- Portas `3000` (API), `5433` (PostgreSQL), `4566` (MiniStack) livres.

## Instalação local (PowerShell/Windows)

```powershell
bun install
Copy-Item .env.example .env  # só se não existir
# Escolha uma senha de desenvolvimento e altere POSTGRES_PASSWORD e DATABASE_URL no .env
# Se já existir um volume PostgreSQL com outra senha, mantenha a senha compatível.

docker compose up -d
bunx --bun mikro-orm migration:up --config ./mikro-orm.config.ts
bun run infra:sqs
bun run typecheck
bun test src/domain
bun run dev
```

**Importante:** a primeira instalação precisa atualizar o `bun.lock` depois de adicionar a dependência `@aws-sdk/client-sqs`; faça commit de `package.json` e `bun.lock` juntos. Em uma máquina nova, depois disso, use `bun install --frozen-lockfile`.

O banco utiliza a porta **5433 do Windows** e a 5432 dentro do container. Não use `docker compose down -v`, pois apaga os dados locais.

### Ativar o consumidor e o publisher SQS

Adicione ao `.env` (se ainda não existirem):

```dotenv
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test
SQS_ENDPOINT=http://127.0.0.1:4566
SQS_ENABLED=1
```

O MiniStack emula SQS localmente; essas credenciais são fictícias. Execute `bun run infra:sqs` após subir o container (outra vez se o MiniStack perder as filas). Para executar somente a API sem mensageria, defina `SQS_ENABLED=0`.

## API

| Método | Rota | Uso |
|---|---|---|
| POST | `/wallets` | Abre carteira; saldo positivo cria `OPENING` e ledger no mesmo commit |
| GET | `/wallets/:walletId` | Consulta saldo e versão |
| GET | `/wallets/:walletId/ledger?limit=50&cursor=...` | Histórico com paginação estável |
| POST | `/wallets/:walletId/reconciliation` | Compara saldo com soma dos lançamentos |
| POST | `/wagering/transactions` | Envia BET/WIN/LOSS/REFUND/ROLLBACK; header `Idempotency-Key` obrigatório |
| GET | `/wagering/transactions/:transactionId` | Consulta transação |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta por identificador do provedor |
| GET | `/health/live` | Liveness |
| GET | `/health/ready` | Readiness de PostgreSQL e SQS |
| GET | `/metrics` | Métricas de estado persistido em formato Prometheus |

Exemplo de carteira (PowerShell):

```powershell
$body = @{ playerId = [guid]::NewGuid().ToString(); initialBalance = @{ amount = '100.00'; currency = 'BRL' } } | ConvertTo-Json -Depth 4
$wallet = Invoke-RestMethod -Uri http://localhost:3000/wallets -Method Post -ContentType application/json -Body $body
$wallet | ConvertTo-Json -Depth 5
```

Exemplo de BET (reutilize o `$wallet` acima):

```powershell
$tx = [guid]::NewGuid().ToString()
$bet = @{
  providerId = 'provider-a'; externalTransactionId = $tx; playerId = $wallet.playerId
  walletId = $wallet.id; roundId = 'round-1'; gameId = 'fortune-chimp'; kind = 'BET'
  money = @{ amount = '30.00'; currency = 'BRL' }
} | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri http://localhost:3000/wagering/transactions -Method Post `
  -ContentType application/json -Headers @{ 'Idempotency-Key' = "provider-a:$tx" } -Body $bet
```

Repetir com a mesma `Idempotency-Key` e payload devolve o resultado original e `idempotentReplay: true`. Mesmo `Idempotency-Key` com outro payload retorna conflito HTTP 409. Rejeições financeiras são HTTP 422; referências pendentes são HTTP 202.

## SQS

Filas criadas pelo script `bun run infra:sqs`:

- `wager-transactions.fifo` — entrada de transações;
- `wager-transactions-dlq.fifo` — DLQ após 5 entregas falhas;
- `wager-events.fifo` — eventos da Outbox.

Formato da mensagem de entrada (enviar a `wager-transactions.fifo` com `MessageGroupId = walletId` e `MessageDeduplicationId` único):

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-07T14:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "tx-123",
    "idempotencyKey": "provider-a:tx-123",
    "playerId": "uuid-do-jogador",
    "walletId": "uuid-da-carteira",
    "roundId": "round-1",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "10.00", "currency": "BRL" }
  }
}
```

`messageId` é a identidade persistente da mensagem enviada pelo provedor. O consumidor deduplica na tabela `inbox_messages` e faz `DeleteMessage` somente após commit. Erros transitórios geram retry com visibilidade crescente; mensagens que excedem as tentativas vão para a DLQ pela RedrivePolicy do SQS. Um evento da Outbox pode ser publicado novamente após uma falha entre o envio e a marcação como publicado; consumidores devem deduplicar por `eventId`.

## Testes

```powershell
bun test src/domain
bun run typecheck

# Requer PostgreSQL e migrations aplicadas; pare o servidor para evitar worker nos mesmos registros
$env:RUN_DB_TESTS = '1'
bun test test/wagering-postgres.integration.test.ts test/wagering-other-postgres.integration.test.ts test/pending-reference-postgres.integration.test.ts test/messaging-postgres.integration.test.ts
Remove-Item Env:RUN_DB_TESTS

# Requer MiniStack + filas e sem API rodando para não consumir mensagens de teste
$env:RUN_SQS_TESTS = '1'
bun test test/messaging-sqs.integration.test.ts
Remove-Item Env:RUN_SQS_TESTS

# Inicia 3 processos Bun/Nest e verifica disputa de saldo e 50 replays
bun run test:multi
```

Os testes de integração gravam dados locais de teste e não apagam o ledger. Considere utilizar um banco de testes separado.

## Status de implementação

O fluxo financeiro principal, ledger, idempotência e polling de referências foram implementados. A Outbox usa triggers PostgreSQL no mesmo commit financeiro; Inbox usa inserção no mesmo `em.transactional()` dos casos de uso. **Não declare produção pronta sem executar os testes e validar o ambiente**. Métricas de latência, de conflito de locks e experimentos de kill/restart ainda demandam cobertura mais completa; consulte `ARCHITECTURE.md`.
