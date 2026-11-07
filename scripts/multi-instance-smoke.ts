import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const ports = [3101, 3102, 3103];
const processes: ChildProcess[] = [];
const base = (port: number) => `http://127.0.0.1:${port}`;

async function awaitHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${base(port)}/health/live`);
      if (response.ok) return;
    } catch { /* aguardar inicialização */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Processo na porta ${port} não iniciou`);
}

async function post(port: number, path: string, body: object, key?: string) {
  const response = await fetch(`${base(port)}${path}`, {
    method: 'POST', headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    }, body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}

async function main(): Promise<void> {
  try {
    for (const port of ports) {
      processes.push(spawn(process.execPath, ['src/main.ts'], {
        cwd: process.cwd(),
        stdio: 'ignore',
        env: { ...process.env, PORT: String(port), SQS_ENABLED: '0', PENDING_REFERENCE_WORKER_ENABLED: '0' },
      }));
    }
    await Promise.all(ports.map(awaitHealth));
    console.log('3 processos NestJS independentes iniciados');
    const playerId = randomUUID();
    const created = await post(3101, '/wallets', {
      playerId, initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    if (created.status !== 201) throw new Error(`Criar Wallet falhou: ${JSON.stringify(created)}`);
    const walletId = String(created.data.id);
    const common = {
      providerId: 'provider-multi', playerId, walletId,
      roundId: randomUUID(), gameId: 'multi-process', kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    };
    const bets = await Promise.all([
      post(3101, '/wagering/transactions', { ...common, externalTransactionId: randomUUID() }, randomUUID()),
      post(3102, '/wagering/transactions', { ...common, externalTransactionId: randomUUID() }, randomUUID()),
    ]);
    const processed = bets.filter((r) => r.data.status === 'PROCESSED').length;
    const rejected = bets.filter((r) => r.data.status === 'REJECTED').length;
    const walletResponse = await fetch(`${base(3103)}/wallets/${walletId}`);
    const wallet = await walletResponse.json() as {balance?: {amount?:string}};
    const ledgerResponse = await fetch(`${base(3103)}/wallets/${walletId}/ledger`);
    const ledger = await ledgerResponse.json() as {items?: Array<{direction?:string}>};
    const debitEntries = ledger.items?.filter((e) => e.direction === 'DEBIT').length;
    if (processed !== 1 || rejected !== 1 || wallet.balance?.amount !== '20.00' || debitEntries !== 1) {
      throw new Error(`Falha de concorrência: ${JSON.stringify({bets,wallet,debitEntries})}`);
    }
    console.log('PASS: 2 BET simultâneas / 3 instâncias => 1 PROCESSED, 1 REJECTED, saldo 20.00');

    const duplicate = {
      ...common, externalTransactionId: randomUUID(),
      money: { amount: '10.00', currency: 'BRL' },
    };
    const key = `provider-multi:${duplicate.externalTransactionId}`;
    const results = await Promise.all(Array.from({ length: 50 }, (_, idx) =>
      post(ports[idx % ports.length], '/wagering/transactions', duplicate, key)));
    if (results.filter((r) => r.data.status === 'PROCESSED').length !== 50 ||
        results.filter((r) => r.data.idempotentReplay === false).length !== 1) {
      throw new Error('50 replays não resultaram em exatamente uma operação original');
    }
    console.log('PASS: 50 requisições idênticas em 3 processos => 1 débito');
  } finally {
    for (const child of processes) child.kill();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
