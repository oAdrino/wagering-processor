import { Money } from '../value-objects/money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceExpired = 'REFERENCE_EXPIRED',
  InvalidReference = 'INVALID_REFERENCE',
  ReferenceScopeMismatch = 'REFERENCE_SCOPE_MISMATCH',
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  DuplicateReversal = 'DUPLICATE_REVERSAL',
  PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}

export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(status: WagerTransactionStatus) {
    super(`Não é possível alterar uma transação no estado ${status}`);
    this.name = 'InvalidTransactionStateError';
  }
}

export class InvalidWagerReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerReferenceError';
  }
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}


export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const required: (keyof CreateWagerTransactionProps)[] = [
      'id', 'providerId', 'externalTransactionId', 'idempotencyKey',
      'payloadHash', 'walletId', 'playerId', 'roundId', 'gameId',
    ];

    for (const field of required) {
      const value = props[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new InvalidWagerTransactionError(`Campo obrigatório inválido: ${field}`);
      }
    }

    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidWagerTransactionError('Tipo de transação inválido');
    }

    if (!(props.money instanceof Money)) {
      throw new InvalidWagerTransactionError('Valor monetário inválido');
    }

    // LOSS não movimenta saldo. Os demais kinds precisam de montante positivo.
    if (props.money.isNegative() ||
        (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive())) {
      throw new InvalidWagerTransactionError('Valor da transação inválido');
    }

    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId?.trim()
    ) {
      throw new InvalidWagerReferenceError(
        'REFUND e ROLLBACK exigem referenceExternalTransactionId',
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(),
      WagerTransactionStatus.Pending,
    );
  }


  // Ler do banco não é uma nova operação: só reconstruímos o estado já salvo.
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt ? new Date(state.processedAt) : undefined,
    );
  }

  get createdAt(): Date { return new Date(this._createdAt); }
  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt) : undefined;
  }

  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markPendingReference(): void {
    this.assertNotTerminal();
    if (!this.requiresReference()) {
      throw new InvalidWagerReferenceError(
        'Somente REFUND e ROLLBACK aguardam referência obrigatória',
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();
    if (this.requiresReference() && !referenceTransactionId?.trim()) {
      throw new InvalidWagerReferenceError('A referência precisa ser resolvida');
    }
    if (Number.isNaN(at.getTime())) {
      throw new InvalidWagerTransactionError('Data de processamento inválida');
    }
    this._referenceTransactionId = referenceTransactionId;
    this._status = WagerTransactionStatus.Processed;
    this._processedAt = new Date(at);
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  // Uma reversão não é sempre crédito: desfazer um WIN precisa debitar.
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS não produz lançamento no ledger');
      case WagerTransactionKind.Refund:
        this.assertReferenceValid(reference, [WagerTransactionKind.Bet]);
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback:
        this.assertReferenceValid(reference, [
          WagerTransactionKind.Bet,
          WagerTransactionKind.Win,
          WagerTransactionKind.Refund,
        ]);
        return reference!.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
    }
  }

  private assertReferenceValid(
    reference: WagerTransaction | undefined,
    allowedKinds: WagerTransactionKind[],
  ): void {
    if (!reference) {
      throw new InvalidWagerReferenceError('Transação de referência não localizada');
    }
    if (!allowedKinds.includes(reference.kind) ||
        reference.status !== WagerTransactionStatus.Processed ||
        reference.externalTransactionId !== this.referenceExternalTransactionId) {
      throw new InvalidWagerReferenceError('Referência inválida ou não processada');
    }
    if (this.providerId !== reference.providerId ||
        this.playerId !== reference.playerId ||
        this.walletId !== reference.walletId ||
        this.roundId !== reference.roundId ||
        this.money.currency !== reference.money.currency) {
      throw new InvalidWagerReferenceError('Referência fora do contexto da operação');
    }
    if (!this.money.equals(reference.money)) {
      throw new InvalidWagerReferenceError('Reversões parciais não são aceitas');
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status);
    }
  }
}
