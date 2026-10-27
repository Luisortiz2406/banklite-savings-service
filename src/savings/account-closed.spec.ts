import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { createTestDatabase, describeWithDb, truncateAll } from '../testing/test-database';
import { AccountClosedService } from './account-closed.service';
import { Cdt } from './entities/cdt.entity';
import { Pocket } from './entities/pocket.entity';
import { SavingsOp } from './entities/savings-op.entity';

const ANA = '11111111-1111-4111-8111-111111111111';
const CARLOS = '22222222-2222-4222-8222-222222222222';

/** account.closed en savings, contra PostgreSQL (bloqueos y saldos numeric reales). */
describeWithDb('Cuenta cancelada: bolsillos y metas (PostgreSQL)', () => {
  let dataSource: DataSource;
  let drop: () => Promise<void>;
  let service: AccountClosedService;

  beforeAll(async () => {
    ({ dataSource, drop } = await createTestDatabase('savings', [Pocket, Cdt, SavingsOp]));
    service = new AccountClosedService(dataSource);
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
  const statusOf = async (id: string) => (await dataSource.getRepository(Pocket).findOneByOrFail({ id })).status;

  it('cierra los bolsillos y metas activos en $0 con su fecha', async () => {
    const vacio = await pocket(ANA, 'pocket', '0');
    const meta = await pocket(ANA, 'goal', '0.00');
    const result = await service.handleAccountClosed(ANA);

    expect(result).toEqual({ cerrados: 2, conDinero: 0, conOperacionEnProceso: 0, cdtsVigentes: 0 });
    for (const id of [vacio.id, meta.id]) {
      const row = await dataSource.getRepository(Pocket).findOneByOrFail({ id });
      expect(row.status).toBe('closed');
      expect(row.closedAt).toBeInstanceOf(Date);
    }
  });

  it('no toca los que tienen dinero (ni un centavo) y lo deja en el log', async () => {
    const conPlata = await pocket(ANA, 'pocket', '0.01');
    const meta = await pocket(ANA, 'goal', '50000');
    const vacio = await pocket(ANA, 'goal', '0');
    const result = await service.handleAccountClosed(ANA);

    expect(result).toMatchObject({ cerrados: 1, conDinero: 2 });
    expect(await statusOf(conPlata.id)).toBe('active');
    expect(await statusOf(meta.id)).toBe('active');
    expect(await statusOf(vacio.id)).toBe('closed');
    const row = await dataSource.getRepository(Pocket).findOneByOrFail({ id: meta.id });
    expect(row.balance).toBe('50000.00');
  });

  it('no cierra uno en $0 con una operación en proceso', async () => {
    const enProceso = await pocket(ANA, 'pocket', '0');
    await dataSource.getRepository(SavingsOp).save({
      idUser: ANA,
      type: 'pocket_out',
      pocketId: enProceso.id,
      amount: '20000',
      idempotencyKey: randomUUID(),
      status: 'pending',
    } as Partial<SavingsOp>);
    const result = await service.handleAccountClosed(ANA);

    expect(result).toMatchObject({ cerrados: 0, conOperacionEnProceso: 1 });
    expect(await statusOf(enProceso.id)).toBe('active');
  });

  it('no toca los CDT ni los bolsillos de otro cliente', async () => {
    const deCarlos = await pocket(CARLOS, 'pocket', '0');
    const cdt = await dataSource.getRepository(Cdt).save({
      idUser: ANA,
      accountId: randomUUID(),
      number: randomUUID().slice(0, 12),
      amount: '1000000',
      days: 90,
      rate: '0.0950',
      gross: '23000',
      tax: '1600',
      net: '21400',
      status: 'active',
      openedAt: new Date(),
      maturesAt: new Date(Date.now() + 90 * 86_400_000),
    } as unknown as Partial<Cdt>);
    const result = await service.handleAccountClosed(ANA);

    expect(result.cdtsVigentes).toBe(1);
    expect((await dataSource.getRepository(Cdt).findOneByOrFail({ id: cdt.id })).status).toBe('active');
    expect(await statusOf(deCarlos.id)).toBe('active');
  });

  it('el evento repetido o simultáneo no cambia nada más', async () => {
    const vacio = await pocket(ANA, 'pocket', '0');
    const yaCerrado = await pocket(ANA, 'goal', '0', 'closed');
    const results = await Promise.all([service.handleAccountClosed(ANA), service.handleAccountClosed(ANA)]);
    expect(results.map((r) => r.cerrados).sort()).toEqual([0, 1]);

    const first = await dataSource.getRepository(Pocket).findOneByOrFail({ id: vacio.id });
    expect((await service.handleAccountClosed(ANA)).cerrados).toBe(0);
    const again = await dataSource.getRepository(Pocket).findOneByOrFail({ id: vacio.id });
    expect(again.closedAt).toEqual(first.closedAt);
    expect((await dataSource.getRepository(Pocket).findOneByOrFail({ id: yaCerrado.id })).closedAt).toBeNull();
  });

  it('un cliente sin ahorro no falla', async () => {
    expect(await service.handleAccountClosed(ANA)).toEqual({
      cerrados: 0,
      conDinero: 0,
      conOperacionEnProceso: 0,
      cdtsVigentes: 0,
    });
  });
});
