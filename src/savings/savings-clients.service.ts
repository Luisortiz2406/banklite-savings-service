import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Falla de un asiento en el ledger. definitive (4xx): seguro no se movió la
 * plata, se revierte lo reservado. Si no (red, timeout, 5xx), no se sabe: la
 * operación queda pendiente y se reintenta con la MISMA clave de idempotencia.
 */
export class LedgerError extends Error {
  constructor(message: string, readonly definitive: boolean) {
    super(message);
  }
}

export type SavingsLedgerKind = 'to_custody' | 'from_custody' | 'interest_to_custody' | 'interest_to_account';

@Injectable()
export class SavingsClientsService {
  constructor(private readonly config: ConfigService) {}

  private url(key: string, fallback: string) {
    return this.config.get<string>(key, fallback).replace(/\/+$/, '');
  }

  /** Cuenta activa del cliente (con su propio token): de ahí sale y ahí vuelve la plata. */
  async receivingAccount(token: string): Promise<{ id: string; accountNumber: string } | null> {
    try {
      const response = await fetch(`${this.url('ACCOUNT_SERVICE_URL', 'http://localhost:3002')}/accounts`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return null;
      const accounts = (await response.json()) as { id: string; accountNumber: string; accountType: string; status: string }[];
      return accounts.find((a) => a.status === 'active' && a.accountType !== 'merchant') ?? null;
    } catch {
      return null;
    }
  }

  /** Asiento de ahorro en el ledger (red interna, idempotente por idempotencyKey). */
  async post(params: {
    kind: SavingsLedgerKind;
    product: 'pocket' | 'cdt';
    accountId: string;
    idUser: string;
    amount: number;
    idempotencyKey: string;
    description: string;
  }): Promise<{ id: string }> {
    const key = this.config.get<string>('INTERNAL_API_KEY');
    if (!key) throw new LedgerError('INTERNAL_API_KEY no está configurada en Savings Service.', false);
    let response: Response;
    try {
      response = await fetch(`${this.url('LEDGER_SERVICE_URL', 'http://localhost:3006')}/ledger/internal/savings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': key },
        body: JSON.stringify({
          kind: params.kind,
          product: params.product,
          accountId: params.accountId,
          beneficiaryUserId: params.idUser,
          amount: params.amount,
          idempotencyKey: params.idempotencyKey,
          description: params.description,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new LedgerError('No se pudo contactar el ledger.', false);
    }
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload as { id: string };
    const message = Array.isArray(payload?.message) ? payload.message.join(', ') : payload?.message || 'El ledger rechazó la operación.';
    throw new LedgerError(String(message).slice(0, 200), response.status >= 400 && response.status < 500);
  }
}
