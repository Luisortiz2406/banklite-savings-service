import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { CDT_MIN, DAY_MS, GOAL_MIN_TARGET, MAX_GOALS, MAX_POCKETS } from './catalog';
import { Cdt } from './entities/cdt.entity';
import { Pocket } from './entities/pocket.entity';
import { SavingsOp } from './entities/savings-op.entity';
import { LedgerError, SavingsClientsService } from './savings-clients.service';
import { SavingsService } from './savings.service';

/**
 * Bolsillos, metas y CDT contra PostgreSQL real (el ledger se simula). Lo que importa:
 * la plata nunca queda a medias. Si el ledger rechaza, lo reservado se devuelve; si no
 * se sabe (red, 5xx), la operación queda pendiente y se completa con la MISMA clave sin
 * mover la plata dos veces.
 */
const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'token-del-cliente';
const ACCOUNT = '3a000000-0000-4000-8000-000000000001';

describeWithDb('SavingsService (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let service: SavingsService;
  let env: Record<string, string>;
  const clients = { receivingAccount: jest.fn(), post: jest.fn() };

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('savings_service', [Pocket, Cdt, SavingsOp]));
    const config = { get: (key: string) => env[key] } as unknown as ConfigService;
    service = new SavingsService(
      dataSource,
      config,
      dataSource.getRepository(Pocket),
      dataSource.getRepository(Cdt),
      dataSource.getRepository(SavingsOp),
      clients as unknown as SavingsClientsService,
    );
  });
  afterAll(() => drop?.());
  beforeEach(async () => {
    await truncateAll(dataSource);
    env = {};
    clients.receivingAccount.mockReset().mockResolvedValue({ id: ACCOUNT, accountNumber: '10000000001' });
    clients.post.mockReset().mockImplementation(async () => ({ id: randomUUID() }));
  });

  const pocketRow = (id: string) => dataSource.getRepository(Pocket).findOneByOrFail({ id });
  const cdtRow = (id: string) => dataSource.getRepository(Cdt).findOneByOrFail({ id });
  const ops = () => dataSource.getRepository(SavingsOp).find({ order: { createdAt: 'ASC' } });
  const newPocket = (overrides: Record<string, unknown> = {}, idUser = ANA) =>
    service.createPocket(idUser, TOKEN, { kind: 'pocket', name: 'Viaje', icon: 'viaje', ...overrides } as never);
  const funded = async (amount = 100_000) => {
    const pocket = await newPocket();
    await service.deposit(ANA, pocket.id, amount, randomUUID());
    clients.post.mockClear();
    return pocket;
  };
  const definitive = (message = 'Saldo insuficiente.') => new LedgerError(message, true);
  const uncertain = (message = 'No se pudo contactar el ledger.') => new LedgerError(message, false);

  describe('crear bolsillos y metas', () => {
    it('crea un bolsillo con saldo 0 en la cuenta activa del cliente, y una meta con su objetivo', async () => {
      const pocket = await newPocket();
      const goal = await service.createPocket(ANA, TOKEN, {
        kind: 'goal',
        name: 'Carro nuevo',
        icon: 'carro',
        target: 5_000_000,
        targetDate: '2999-01-01',
      });

      expect(pocket).toMatchObject({ kind: 'pocket', name: 'Viaje', balance: 0, rate: 0.09, target: null });
      expect(goal).toMatchObject({
        kind: 'goal',
        target: 5_000_000,
        targetDate: '2999-01-01',
        rate: 0,
        completed: false,
      });
      expect((await pocketRow(pocket.id)).accountId).toBe(ACCOUNT);
    });

    it('valida el nombre, el ícono, el objetivo y la fecha de la meta', async () => {
      await expect(newPocket({ name: ' a ' })).rejects.toThrow('Ponle un nombre a tu bolsillo');
      await expect(newPocket({ icon: 'inventado' })).rejects.toThrow('Ícono no válido');
      await expect(newPocket({ kind: 'goal', icon: 'viaje' })).rejects.toThrow('al menos $10.000');
      await expect(newPocket({ kind: 'goal', icon: 'viaje', target: GOAL_MIN_TARGET - 1 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        newPocket({ kind: 'goal', icon: 'viaje', target: 50_000, targetDate: '2000-01-01' }),
      ).rejects.toThrow('fecha de la meta debe ser futura');
    });

    it('no repite nombres (sin importar mayúsculas), respeta los máximos y exige una cuenta activa', async () => {
      await newPocket({ name: 'Viaje' });
      await expect(newPocket({ name: 'VIAJE' })).rejects.toBeInstanceOf(ConflictException);
      await expect(newPocket({ name: 'Viaje' }, CARLOS)).resolves.toBeDefined(); // otro cliente sí

      for (let i = 1; i < MAX_POCKETS; i++) await newPocket({ name: `Bolsillo ${i}` });
      await expect(newPocket({ name: 'Uno más' })).rejects.toThrow(`máximo ${MAX_POCKETS} bolsillos`);
      for (let i = 0; i < MAX_GOALS; i++) {
        await newPocket({ kind: 'goal', name: `Meta ${i}`, icon: 'casa', target: 100_000 });
      }
      await expect(newPocket({ kind: 'goal', name: 'Otra', icon: 'casa', target: 100_000 })).rejects.toThrow(
        `máximo ${MAX_GOALS} metas`,
      );

      clients.receivingAccount.mockResolvedValue(null);
      await expect(newPocket({ name: 'Sin cuenta' }, randomUUID())).rejects.toThrow('cuenta Banklite activa');
    });
  });

  describe('agregar plata', () => {
    it('manda al ledger el asiento hacia la custodia con la clave de idempotencia y sube el saldo', async () => {
      const pocket = await newPocket();
      const key = randomUUID();

      const result = await service.deposit(ANA, pocket.id, 50_000, key);

      expect(clients.post).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'to_custody',
          product: 'pocket',
          accountId: ACCOUNT,
          idUser: ANA,
          amount: 50_000,
          idempotencyKey: key,
          description: 'Dinero a bolsillo · Viaje',
        }),
      );
      expect(result).toMatchObject({ status: 'completed', pocket: { balance: 50_000 } });
      expect(Number((await pocketRow(pocket.id)).balance)).toBe(50_000);
    });

    it('el valor mínimo es $1.000, y un bolsillo ajeno o cerrado no existe', async () => {
      const pocket = await newPocket();

      await expect(service.deposit(ANA, pocket.id, 999, randomUUID())).rejects.toThrow('valor mínimo es $1.000');
      await expect(service.deposit(ANA, pocket.id, NaN, randomUUID())).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.deposit(CARLOS, pocket.id, 5_000, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.deposit(ANA, randomUUID(), 5_000, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
      await dataSource.getRepository(Pocket).update(pocket.id, { status: 'closed' });
      await expect(service.deposit(ANA, pocket.id, 5_000, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
      expect(clients.post).not.toHaveBeenCalled();
    });

    it('repetir la misma clave devuelve el mismo resultado y no mueve la plata otra vez', async () => {
      const pocket = await newPocket();
      const key = randomUUID();
      await service.deposit(ANA, pocket.id, 50_000, key);

      const again = await service.deposit(ANA, pocket.id, 50_000, key);

      expect(again.status).toBe('completed');
      expect(clients.post).toHaveBeenCalledTimes(1);
      expect(Number((await pocketRow(pocket.id)).balance)).toBe(50_000);
      await expect(service.deposit(CARLOS, pocket.id, 50_000, key)).rejects.toThrow('clave de idempotencia ya se usó');
    });

    it('si el ledger lo rechaza (saldo insuficiente) el saldo no cambia, queda fallida y repetirla da conflicto', async () => {
      const pocket = await newPocket();
      const key = randomUUID();
      clients.post.mockRejectedValueOnce(definitive('Saldo insuficiente.'));

      await expect(service.deposit(ANA, pocket.id, 50_000, key)).rejects.toThrow('Saldo insuficiente.');

      expect(Number((await pocketRow(pocket.id)).balance)).toBe(0);
      expect((await ops())[0]).toMatchObject({ status: 'failed', failureReason: 'Saldo insuficiente.' });
      await expect(service.deposit(ANA, pocket.id, 50_000, key)).rejects.toBeInstanceOf(ConflictException);
    });

    it('si no se sabe si el ledger lo aplicó (red o 5xx) queda pendiente y se completa con la MISMA clave, una sola vez', async () => {
      const pocket = await newPocket();
      const key = randomUUID();
      clients.post.mockRejectedValueOnce(uncertain());

      await expect(service.deposit(ANA, pocket.id, 50_000, key)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect((await ops())[0].status).toBe('pending');
      expect(Number((await pocketRow(pocket.id)).balance)).toBe(0);

      const retried = await service.deposit(ANA, pocket.id, 50_000, key);

      expect(retried.status).toBe('completed');
      expect(clients.post).toHaveBeenCalledTimes(2);
      expect(clients.post.mock.calls[0][0].idempotencyKey).toBe(key);
      expect(clients.post.mock.calls[1][0].idempotencyKey).toBe(key);
      expect(Number((await pocketRow(pocket.id)).balance)).toBe(50_000);
    });

    it('un error inesperado (no del ledger) se propaga sin tocar el saldo', async () => {
      const pocket = await newPocket();
      clients.post.mockRejectedValueOnce(new Error('bug'));

      await expect(service.deposit(ANA, pocket.id, 50_000, randomUUID())).rejects.toThrow('bug');
      expect(Number((await pocketRow(pocket.id)).balance)).toBe(0);
    });

    it('antes de agregar, los intereses causados del bolsillo se capitalizan con su propio asiento', async () => {
      const pocket = await funded(1_000_000);
      await dataSource.getRepository(Pocket).update(pocket.id, { lastAccrualAt: new Date(Date.now() - 365 * DAY_MS) });

      await service.deposit(ANA, pocket.id, 10_000, randomUUID());

      const kinds = clients.post.mock.calls.map((call) => call[0].kind);
      expect(kinds).toEqual(['interest_to_custody', 'to_custody']);
      const row = await pocketRow(pocket.id);
      expect(Number(row.earned)).toBeCloseTo(90_000, -2); // 9 % efectivo anual
      expect(Number(row.balance)).toBeCloseTo(1_100_000, -2);
    });

    it('una meta no renta intereses', async () => {
      const goal = await service.createPocket(ANA, TOKEN, {
        kind: 'goal',
        name: 'Meta',
        icon: 'casa',
        target: 500_000,
      });
      await service.deposit(ANA, goal.id, 100_000, randomUUID());
      await dataSource.getRepository(Pocket).update(goal.id, { lastAccrualAt: new Date(Date.now() - 365 * DAY_MS) });
      clients.post.mockClear();

      await service.deposit(ANA, goal.id, 1_000, randomUUID());

      expect(clients.post.mock.calls.map((call) => call[0].kind)).toEqual(['to_custody']);
    });
  });

  describe('sacar plata', () => {
    it('baja el saldo y manda al ledger el asiento desde la custodia', async () => {
      const pocket = await funded(100_000);

      const result = await service.withdraw(ANA, pocket.id, 40_000, randomUUID());

      expect(clients.post).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'from_custody', amount: 40_000, description: 'Retiro de bolsillo · Viaje' }),
      );
      expect(result).toMatchObject({ status: 'completed', pocket: { balance: 60_000 } });
    });

    it('no deja sacar más de lo que hay ni menos de $1.000', async () => {
      const pocket = await funded(100_000);

      await expect(service.withdraw(ANA, pocket.id, 100_001, randomUUID())).rejects.toThrow('tienes 100.000');
      await expect(service.withdraw(ANA, pocket.id, 500, randomUUID())).rejects.toThrow('valor mínimo');
      expect(clients.post).not.toHaveBeenCalled();
      expect(Number((await pocketRow(pocket.id)).balance)).toBe(100_000);
    });

    it('si el ledger lo rechaza, lo reservado se devuelve al bolsillo', async () => {
      const pocket = await funded(100_000);
      clients.post.mockRejectedValueOnce(definitive('La cuenta no está activa.'));

      await expect(service.withdraw(ANA, pocket.id, 40_000, randomUUID())).rejects.toThrow('La cuenta no está activa');

      expect(Number((await pocketRow(pocket.id)).balance)).toBe(100_000);
      expect((await ops()).at(-1)).toMatchObject({ type: 'pocket_out', status: 'failed' });
    });

    it('si no se sabe, el saldo queda reservado (ya bajó) y el reintento con la misma clave lo completa una sola vez', async () => {
      const pocket = await funded(100_000);
      const key = randomUUID();
      clients.post.mockRejectedValueOnce(uncertain());

      await expect(service.withdraw(ANA, pocket.id, 40_000, key)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(Number((await pocketRow(pocket.id)).balance)).toBe(60_000); // reservado: no se puede gastar dos veces

      await service.withdraw(ANA, pocket.id, 40_000, key);

      expect(Number((await pocketRow(pocket.id)).balance)).toBe(60_000);
      expect(clients.post.mock.calls.at(-1)[0].idempotencyKey).toBe(key);
    });

    it('cerrar saca todo y cierra; si estaba en cero, se cierra sin tocar el ledger; si el ledger falla, no se cierra', async () => {
      const full = await funded(80_000);
      const closed = await service.withdraw(ANA, full.id, null, randomUUID(), true);
      expect(clients.post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'from_custody', amount: 80_000 }));
      expect((await pocketRow(full.id)).status).toBe('closed');
      expect(closed.status).toBe('completed');

      clients.post.mockClear();
      const empty = await newPocket({ name: 'Vacío' });
      expect(await service.withdraw(ANA, empty.id, null, randomUUID(), true)).toMatchObject({ status: 'completed' });
      expect((await pocketRow(empty.id)).status).toBe('closed');
      expect(clients.post).not.toHaveBeenCalled();

      const risky = await funded(80_000);
      clients.post.mockRejectedValueOnce(definitive());
      await expect(service.withdraw(ANA, risky.id, null, randomUUID(), true)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(await pocketRow(risky.id)).toMatchObject({ status: 'active' });
      expect(Number((await pocketRow(risky.id)).balance)).toBe(80_000);
    });
  });

  describe('CDT', () => {
    const open = (amount = 1_000_000, days = 90, key = randomUUID()) => service.openCdt(ANA, TOKEN, amount, days, key);

    it('abre el CDT: calcula intereses y retención del 4 %, manda el asiento hacia la custodia de CDT y queda activo', async () => {
      const result = await open(1_000_000, 90);

      expect(clients.post).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'to_custody', product: 'cdt', amount: 1_000_000 }),
      );
      expect(result.status).toBe('completed');
      expect(result.cdt).toMatchObject({ amount: 1_000_000, days: 90, rate: 0.095, status: 'active', matured: false });
      expect(result.cdt.gross).toBe(22_630.04); // 1.000.000 × (1,095^(90/365) − 1), truncado a centavos
      expect(result.cdt.tax).toBeCloseTo(result.cdt.gross * 0.04, 1);
      expect(result.cdt.net).toBeCloseTo(result.cdt.gross - result.cdt.tax, 1);
      expect(result.cdt.total).toBeCloseTo(1_000_000 + result.cdt.net, 1);
      expect(result.cdt.number).toMatch(/^CDT\d{7}$/);
    });

    it('valida el plazo, el monto mínimo (en pesos enteros) y que haya una cuenta activa', async () => {
      await expect(open(1_000_000, 45)).rejects.toThrow('plazo no está disponible');
      await expect(open(CDT_MIN - 1)).rejects.toThrow('monto mínimo para un CDT');
      await expect(open(1_000_000.5)).rejects.toBeInstanceOf(BadRequestException);
      clients.receivingAccount.mockResolvedValueOnce(null);
      await expect(open()).rejects.toThrow('cuenta Banklite activa');
      expect(clients.post).not.toHaveBeenCalled();
      expect(await dataSource.getRepository(Cdt).count()).toBe(0);
    });

    it('si el ledger rechaza la apertura (saldo insuficiente) el CDT queda fallido y no se cuenta', async () => {
      clients.post.mockRejectedValueOnce(definitive('Saldo insuficiente.'));

      await expect(open()).rejects.toThrow('Saldo insuficiente.');

      const [cdt] = await dataSource.getRepository(Cdt).find();
      expect(cdt.status).toBe('failed');
      expect((await service.summary(ANA)).cdts).toEqual([]);
    });

    it('si no se sabe si el ledger lo aplicó, queda en apertura y repetir con la misma clave lo completa', async () => {
      const key = randomUUID();
      clients.post.mockRejectedValueOnce(uncertain());

      await expect(open(1_000_000, 90, key)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect((await dataSource.getRepository(Cdt).find())[0].status).toBe('opening');

      const retried = await open(1_000_000, 90, key);

      expect(retried.cdt.status).toBe('active');
      expect(await dataSource.getRepository(Cdt).count()).toBe(1);
      expect(clients.post.mock.calls.map((call) => call[0].idempotencyKey)).toEqual([key, key]);
    });

    describe('cobrar al vencimiento', () => {
      const matured = async () => {
        const { cdt } = await open();
        await dataSource.getRepository(Cdt).update(cdt.id, { maturesAt: new Date(Date.now() - 1_000) });
        clients.post.mockClear();
        return cdt;
      };

      it('antes de vencer no se cobra; uno ajeno o inexistente no existe', async () => {
        const { cdt } = await open();

        await expect(service.collectCdt(ANA, cdt.id, randomUUID())).rejects.toThrow('todavía no ha vencido');
        await expect(service.collectCdt(CARLOS, cdt.id, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
        await expect(service.collectCdt(ANA, randomUUID(), randomUUID())).rejects.toBeInstanceOf(NotFoundException);
      });

      it('vencido, devuelve el capital desde la custodia y paga los intereses netos desde "Intereses pagados", y queda pagado', async () => {
        const cdt = await matured();

        const result = await service.collectCdt(ANA, cdt.id, randomUUID());

        const calls = clients.post.mock.calls.map((call) => call[0]);
        expect(calls.map((c) => [c.kind, c.product])).toEqual([
          ['from_custody', 'cdt'],
          ['interest_to_account', 'cdt'],
        ]);
        expect(calls[0].amount).toBe(1_000_000);
        expect(calls[1].amount).toBeCloseTo(cdt.net, 2);
        expect(result.cdt.status).toBe('paid');
        expect((await cdtRow(cdt.id)).paidAt).toBeInstanceOf(Date);
      });

      it('cobrar otra vez (misma clave o cualquier otra) no paga dos veces', async () => {
        const cdt = await matured();
        const key = randomUUID();
        await service.collectCdt(ANA, cdt.id, key);
        clients.post.mockClear();

        expect((await service.collectCdt(ANA, cdt.id, key)).status).toBe('completed');
        expect((await service.collectCdt(ANA, cdt.id, randomUUID())).cdt.status).toBe('paid');
        expect(clients.post).not.toHaveBeenCalled();
      });

      it('si el ledger rechaza la devolución del capital, el CDT vuelve a activo y no se paga el interés', async () => {
        const cdt = await matured();
        clients.post.mockRejectedValueOnce(definitive('Error del ledger.'));

        await expect(service.collectCdt(ANA, cdt.id, randomUUID())).rejects.toThrow('Error del ledger.');

        expect((await cdtRow(cdt.id)).status).toBe('active');
        expect(clients.post).toHaveBeenCalledTimes(1);
        const remaining = (await ops()).filter((o) => o.type === 'cdt_principal' || o.type === 'cdt_interest');
        expect(remaining).toEqual([]);

        // Se puede volver a cobrar.
        expect((await service.collectCdt(ANA, cdt.id, randomUUID())).cdt.status).toBe('paid');
      });

      it('si no se sabe, queda cobrando; un nuevo intento completa solo lo que falta (el capital no se devuelve dos veces)', async () => {
        const cdt = await matured();
        clients.post.mockResolvedValueOnce({ id: randomUUID() }).mockRejectedValueOnce(uncertain());

        await expect(service.collectCdt(ANA, cdt.id, randomUUID())).rejects.toBeInstanceOf(ServiceUnavailableException);
        expect((await cdtRow(cdt.id)).status).toBe('collecting');
        clients.post.mockClear();

        const result = await service.collectCdt(ANA, cdt.id, randomUUID());

        expect(result.cdt.status).toBe('paid');
        expect(clients.post.mock.calls.map((call) => call[0].kind)).toEqual(['interest_to_account']);
      });

      it('la red de seguridad: si el interés quedó pendiente, el resumen lo completa pasados 30 segundos', async () => {
        const cdt = await matured();
        clients.post.mockResolvedValueOnce({ id: randomUUID() }).mockRejectedValueOnce(uncertain());
        await expect(service.collectCdt(ANA, cdt.id, randomUUID())).rejects.toBeInstanceOf(ServiceUnavailableException);
        await dataSource.query(`UPDATE savings_ops SET updated_at = now() - interval '1 minute'`);

        const summary = await service.summary(ANA);

        expect(summary.cdts[0].status).toBe('paid');
      });

      it('un CDT que no está activo ni cobrando no se puede cobrar', async () => {
        const cdt = await matured();
        await dataSource.getRepository(Cdt).update(cdt.id, { status: 'failed' });

        await expect(service.collectCdt(ANA, cdt.id, randomUUID())).rejects.toBeInstanceOf(ConflictException);
      });
    });

    it('la simulación de vencimiento solo existe si está habilitada', async () => {
      const { cdt } = await open();

      await expect(service.demoMature(ANA, cdt.id)).rejects.toBeInstanceOf(ForbiddenException);
      env.ENABLE_DEMO_MATURITY = 'true';
      expect((await service.demoMature(ANA, cdt.id)).matured).toBe(true);
      await expect(service.demoMature(CARLOS, cdt.id)).rejects.toBeInstanceOf(NotFoundException);
      expect((await service.collectCdt(ANA, cdt.id, randomUUID())).cdt.status).toBe('paid');
    });
  });

  describe('resumen', () => {
    it('suma bolsillos, metas y CDT por separado y calcula los hitos para los retos de puntos', async () => {
      const pocket = await newPocket();
      const goal = await service.createPocket(ANA, TOKEN, {
        kind: 'goal',
        name: 'Meta',
        icon: 'casa',
        target: 200_000,
      });
      await service.deposit(ANA, pocket.id, 30_000, randomUUID());
      await service.deposit(ANA, goal.id, 200_000, randomUUID());
      await service.openCdt(ANA, TOKEN, 600_000, 30, randomUUID());

      const summary = await service.summary(ANA);

      expect(summary.totals).toMatchObject({ inPockets: 30_000, inGoals: 200_000, inCdts: 600_000 });
      expect(summary.goals[0]).toMatchObject({ completed: true });
      expect(summary.milestones).toEqual({ hasPocket: true, hasCdt: true });
      expect(summary.config.demoMaturity).toBe(false);
      expect(await service.summary(CARLOS)).toMatchObject({
        pockets: [],
        milestones: { hasPocket: false, hasCdt: false },
        totals: { inPockets: 0, inGoals: 0, inCdts: 0 },
      });
    });

    it('un bolsillo que tuvo plata y se vació sigue contando para el hito, y uno cerrado no aparece', async () => {
      const pocket = await funded(10_000);
      await service.withdraw(ANA, pocket.id, null, randomUUID(), true);

      const summary = await service.summary(ANA);

      expect(summary.pockets).toEqual([]);
      expect(summary.milestones.hasPocket).toBe(true);
    });

    it('al consultar el resumen reintenta las operaciones pendientes de hace más de 30 s', async () => {
      const pocket = await newPocket();
      clients.post.mockRejectedValueOnce(uncertain());
      await expect(service.deposit(ANA, pocket.id, 25_000, randomUUID())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await dataSource.query(`UPDATE savings_ops SET updated_at = now() - interval '1 minute'`);

      const summary = await service.summary(ANA);

      expect(summary.pockets[0].balance).toBe(25_000);
      expect((await ops())[0].status).toBe('completed');
    });
  });
});
