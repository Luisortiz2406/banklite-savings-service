import { randomUUID } from 'crypto';
import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { ClosureSummaryService } from './closure-summary.service';
import { Cdt } from './entities/cdt.entity';
import { Pocket } from './entities/pocket.entity';
import { SavingsOp } from './entities/savings-op.entity';
import { InternalSavingsController } from './internal-savings.controller';

/** Resumen para cancelar la cuenta, contra PostgreSQL (saldos numeric y estados reales). */
describeWithDb('Resumen de ahorro para cancelar la cuenta (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let service: ClosureSummaryService;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('savings', [Pocket, Cdt, SavingsOp]));
    service = new ClosureSummaryService(
      dataSource.getRepository(Pocket),
      dataSource.getRepository(Cdt),
      dataSource.getRepository(SavingsOp),
    );
  });
  afterAll(() => drop?.());
  beforeEach(() => truncateAll(dataSource));

  const pocket = (idUser: string, kind: 'pocket' | 'goal', balance: string, status = 'active') =>
    dataSource.getRepository(Pocket).save({
      idUser,
      accountId: randomUUID(),
      kind,
      name: 'Prueba',
      icon: 'otro',
      balance,
      status,
      lastAccrualAt: new Date(),
    } as Partial<Pocket>);
  const cdt = (idUser: string, status: Cdt['status']) =>
    dataSource.getRepository(Cdt).save({
      idUser,
      accountId: randomUUID(),
      number: randomUUID().slice(0, 12),
      amount: '1000000',
      days: 90,
      rate: '0.0950',
      gross: '23000',
      tax: '1600',
      net: '21400',
      openedAt: new Date(),
      maturesAt: new Date(Date.now() + 90 * 86_400_000),
      status,
    } as Partial<Cdt>);
  const op = (idUser: string, status: SavingsOp['status']) =>
    dataSource.getRepository(SavingsOp).save({
      idUser,
      type: 'pocket_in',
      amount: '1000',
      idempotencyKey: randomUUID(),
      status,
    } as Partial<SavingsOp>);

  it('sin ahorro: nada impide cancelar', async () => {
    expect(await service.summary(randomUUID())).toEqual({
      bolsillosConDinero: 0,
      metasConDinero: 0,
      saldoApartado: 0,
      cdtsVigentes: 0,
      operacionesEnProceso: 0,
      sinPendientes: true,
    });
  });

  it('cuenta bolsillos y metas con dinero, CDT vigentes y operaciones en proceso', async () => {
    const idUser = randomUUID();
    await pocket(idUser, 'pocket', '150000.50');
    await pocket(idUser, 'goal', '0.01');
    await pocket(idUser, 'pocket', '0'); // vacío: no impide
    await pocket(idUser, 'goal', '500', 'closed'); // cerrado: no cuenta
    await cdt(idUser, 'active');
    await cdt(idUser, 'opening');
    await cdt(idUser, 'paid'); // ya pagado: no impide
    await op(idUser, 'pending');
    await op(idUser, 'completed');
    await pocket(randomUUID(), 'pocket', '999'); // de otro cliente

    expect(await service.summary(idUser)).toEqual({
      bolsillosConDinero: 1,
      metasConDinero: 1,
      saldoApartado: 150000.51,
      cdtsVigentes: 2,
      operacionesEnProceso: 1,
      sinPendientes: false,
    });
  });

  it('solo bolsillos vacíos y CDT pagados: puede cancelar', async () => {
    const idUser = randomUUID();
    await pocket(idUser, 'pocket', '0');
    await cdt(idUser, 'paid');
    await cdt(idUser, 'failed');
    expect((await service.summary(idUser)).sinPendientes).toBe(true);
  });
});

describe('GET /internal/savings/users/:idUser/resumen-cierre (permisos)', () => {
  const ACCOUNT_KEY = 'a1'.repeat(32);
  const LEDGER_KEY = 'b2'.repeat(32);
  const guard = new InternalKeyGuard(
    new ConfigService({ INTERNAL_TRUSTED_KEYS: `account:${ACCOUNT_KEY},ledger:${LEDGER_KEY}` }),
  );
  const context = (key?: string) => {
    const request: any = { headers: key ? { 'x-internal-key': key } : {} };
    return {
      request,
      ctx: { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext,
    };
  };
  const controller = new InternalSavingsController({ summary: async () => ({ sinPendientes: true }) } as never);

  it('sin clave o con una clave desconocida: 401', () => {
    expect(() => guard.canActivate(context().ctx)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context('c3'.repeat(32)).ctx)).toThrow(UnauthorizedException);
  });

  it('account-service: pasa; otro servicio con clave válida: 403', async () => {
    const account = context(ACCOUNT_KEY);
    expect(guard.canActivate(account.ctx)).toBe(true);
    await expect(controller.resumenCierre(randomUUID(), account.request)).resolves.toEqual({ sinPendientes: true });

    const ledger = context(LEDGER_KEY);
    expect(guard.canActivate(ledger.ctx)).toBe(true);
    expect(() => controller.resumenCierre(randomUUID(), ledger.request)).toThrow(ForbiddenException);
  });
});
