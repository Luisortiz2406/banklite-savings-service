import { ConfigService } from '@nestjs/config';
import { cdtResult, CDT_TERMS, interestFor, savingsCatalog } from './catalog';
import { LedgerError, SavingsClientsService } from './savings-clients.service';

/**
 * Asientos de ahorro en el ledger (fetch simulado). Regla: un 4xx es un rechazo definitivo
 * (seguro no se movió plata); un 5xx, la falta de respuesta o el 401 de la clave interna
 * son inciertos y se reintentan con la misma clave. También, las cuentas del catálogo.
 */
const KEY = 'clave-interna-de-savings-para-pruebas-0123';
const reply = (status: number, body: unknown = {}) =>
  Promise.resolve({ status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response);

describe('SavingsClientsService', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const build = (env: Record<string, string> = {}) =>
    new SavingsClientsService(new ConfigService({ INTERNAL_API_KEY: KEY, ...env }));
  const params = {
    kind: 'to_custody' as const,
    product: 'pocket' as const,
    accountId: 'a1',
    idUser: 'u1',
    amount: 50_000,
    idempotencyKey: 'k1',
    description: 'Dinero a bolsillo',
  };
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as LedgerError;
    }
    throw new Error('no lanzó excepción');
  };

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  describe('cuenta que recibe', () => {
    it('es la primera cuenta activa de persona, consultada con el token del propio cliente', async () => {
      fetchMock.mockReturnValue(
        reply(200, [
          { id: 'm1', accountNumber: '1', accountType: 'merchant', status: 'active' },
          { id: 'b1', accountNumber: '2', accountType: 'savings', status: 'blocked' },
          { id: 'a1', accountNumber: '3', accountType: 'checking', status: 'active' },
        ]),
      );

      expect(
        await build({ ACCOUNT_SERVICE_URL: 'http://account.interno:3002/' }).receivingAccount('tok'),
      ).toMatchObject({
        id: 'a1',
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://account.interno:3002/accounts');
      expect(init.headers.Authorization).toBe('Bearer tok');
    });

    it('sin cuenta activa, o si account-service falla o no responde, devuelve null', async () => {
      fetchMock.mockReturnValueOnce(reply(200, [{ id: 'b1', accountType: 'savings', status: 'blocked' }]));
      expect(await build().receivingAccount('tok')).toBeNull();
      fetchMock.mockReturnValueOnce(reply(401, {}));
      expect(await build().receivingAccount('tok')).toBeNull();
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await build().receivingAccount('tok')).toBeNull();
    });
  });

  describe('asiento en el ledger', () => {
    it('manda el movimiento con la clave interna, la clave de idempotencia y el titular, y devuelve el asiento', async () => {
      fetchMock.mockReturnValue(reply(201, { id: 'tx-1' }));

      expect(await build({ LEDGER_SERVICE_URL: 'http://ledger.interno:3006/' }).post(params)).toEqual({ id: 'tx-1' });

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('http://ledger.interno:3006/ledger/internal/savings');
      expect(init.headers['x-internal-key']).toBe(KEY);
      expect(JSON.parse(init.body)).toEqual({
        kind: 'to_custody',
        product: 'pocket',
        accountId: 'a1',
        beneficiaryUserId: 'u1',
        amount: 50_000,
        idempotencyKey: 'k1',
        description: 'Dinero a bolsillo',
      });
    });

    it('un 4xx (saldo insuficiente, cuenta inactiva) es un rechazo definitivo con el motivo del ledger', async () => {
      for (const status of [400, 403, 409]) {
        fetchMock.mockReturnValueOnce(reply(status, { message: 'Saldo insuficiente.' }));
        const error = await failure(build().post(params));
        expect(error).toBeInstanceOf(LedgerError);
        expect(error).toMatchObject({ definitive: true, message: 'Saldo insuficiente.' });
      }
      fetchMock.mockReturnValueOnce(reply(400, {}));
      expect((await failure(build().post(params))).message).toBe('El ledger rechazó la operación.');
      fetchMock.mockReturnValueOnce(reply(400, { message: 'x'.repeat(500) }));
      expect((await failure(build().post(params))).message).toHaveLength(200);
    });

    it('un 5xx, un 401 (clave interna) o la falta de respuesta son inciertos: no se asume que no se movió la plata', async () => {
      for (const status of [500, 502, 503, 401]) {
        fetchMock.mockReturnValueOnce(reply(status, { message: 'x' }));
        expect(await failure(build().post(params))).toMatchObject({ definitive: false });
      }
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
      expect(await failure(build().post(params))).toMatchObject({
        definitive: false,
        message: 'No se pudo contactar el ledger.',
      });
    });

    it('un asiento nunca se reintenta solo, y sin INTERNAL_API_KEY no sale la llamada (incierto)', async () => {
      fetchMock.mockReturnValue(reply(503, {}));
      await failure(build().post(params));
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockClear();
      const error = await failure(new SavingsClientsService(new ConfigService({})).post(params));
      expect(error).toMatchObject({ definitive: false });
      expect(error.message).toContain('INTERNAL_API_KEY');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe('catálogo de ahorro', () => {
  it('el interés es compuesto con tasa efectiva anual, truncado a centavos, y 0 sin monto, días o tasa', () => {
    expect(interestFor(1_000_000, 0.09, 365)).toBe(90_000);
    expect(interestFor(1_000_000, 0.095, 90)).toBe(22_630.04);
    expect(interestFor(0, 0.09, 30)).toBe(0);
    expect(interestFor(1_000_000, 0, 30)).toBe(0);
    expect(interestFor(1_000_000, 0.09, 0)).toBe(0);
    expect(interestFor(-5, 0.09, 30)).toBe(0);
  });

  it('el CDT descuenta la retención del 4 % de los intereses y el total suma el capital más el neto', () => {
    const result = cdtResult(1_000_000, 0.095, 90);

    expect(result).toEqual({ gross: 22_630.04, tax: 905.2, net: 21_724.84, total: 1_021_724.84 });
    expect(cdtResult(1_000_000, 0.11, 360).net).toBeGreaterThan(result.net);
  });

  it('cada plazo tiene una tasa mayor que el anterior y el catálogo publica los topes', () => {
    const rates = CDT_TERMS.map((term) => term.rate);
    expect([...rates].sort((a, b) => a - b)).toEqual(rates);
    expect(CDT_TERMS.map((term) => term.days)).toEqual([30, 60, 90, 180, 360]);
    expect(savingsCatalog()).toMatchObject({
      pocketRate: 0.09,
      cdtMin: 500_000,
      cdtTax: 0.04,
      minMove: 1_000,
      maxPockets: 8,
      maxGoals: 10,
      goalMinTarget: 10_000,
    });
  });
});
