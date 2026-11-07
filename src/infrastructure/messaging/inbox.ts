import { BadRequestException } from '@nestjs/common';
import type { EntityManager } from '@mikro-orm/core';
import type { EntityManager as SqlEntityManager } from '@mikro-orm/postgresql';

/** Dados do transporte. Não participam do hash de negócio/Idempotency-Key. */
export interface InboxReceipt {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

/** Chamar DENTRO da mesma transação do caso de uso, depois de sua execução. */
export async function persistInbox(em: EntityManager, receipt?: InboxReceipt): Promise<void> {
  if (!receipt) return;
  const { consumerName, messageId, payloadHash } = receipt;
  if (!consumerName || !messageId || !/^[a-f0-9]{64}$/i.test(payloadHash)) {
    throw new BadRequestException('Identificação da Inbox inválida');
  }
  const result = await (em as SqlEntityManager).execute<{payload_hash: string}[]>(
    `insert into inbox_messages (consumer_name, message_id, payload_hash)
     values (?, ?, ?) on conflict (consumer_name, message_id) do nothing
     returning payload_hash`,
    [consumerName, messageId, payloadHash],
  );
  // Se já existe a mesma mensagem, verifico se o conteúdo continua igual.
  // Um mesmo messageId com payload diferente não pode virar replay válido.
  if (result.length) return;
  const existing = await (em as SqlEntityManager).execute<{payload_hash: string}[]>(
    `select payload_hash from inbox_messages where consumer_name = ? and message_id = ?`,
    [consumerName, messageId],
  );
  if (!existing.length || existing[0].payload_hash !== payloadHash) {
    throw new BadRequestException('messageId reutilizado com payload diferente');
  }
}
