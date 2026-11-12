import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { savingsCatalog } from './catalog';
import { InternalSavingsController } from './internal-savings.controller';
import { SavingsCatalogController } from './savings-catalog.controller';
import { SavingsController } from './savings.controller';
import { SavingsService } from './savings.service';

const guardsOf = (target: object) => Reflect.getMetadata('__guards__', target) ?? [];
const ANA = '11111111-1111-4111-8111-111111111111';
const KEY = '33333333-3333-4333-8333-333333333333';
const request = { user: { idUser: ANA }, accessToken: 'tok-1' } as never;

describe('SavingsController', () => {
  const service = {
    summary: jest.fn().mockResolvedValue({}),
    createPocket: jest.fn().mockResolvedValue({}),
    deposit: jest.fn().mockResolvedValue({}),
    withdraw: jest.fn().mockResolvedValue({}),
    openCdt: jest.fn().mockResolvedValue({}),
    collectCdt: jest.fn().mockResolvedValue({}),
    demoMature: jest.fn().mockResolvedValue({}),
  };
  const controller = new SavingsController(service as unknown as SavingsService);

  it('exige sesión y todo es del cliente de la sesión (con su token donde hace falta consultar la cuenta)', async () => {
    expect(guardsOf(SavingsController)).toContain(JwtAuthGuard);

    await controller.summary(request);
    expect(service.summary).toHaveBeenCalledWith(ANA);
    const dto = { kind: 'pocket', name: 'Viaje', icon: 'viaje' } as never;
    await controller.createPocket(dto, request);
    expect(service.createPocket).toHaveBeenCalledWith(ANA, 'tok-1', dto);
    await controller.openCdt({ amount: 600_000, days: 90, idempotencyKey: KEY }, request);
    expect(service.openCdt).toHaveBeenCalledWith(ANA, 'tok-1', 600_000, 90, KEY);
  });

  it('agregar, sacar, cerrar y cobrar pasan la clave de idempotencia; cerrar saca todo y cierra', async () => {
    await controller.deposit('p1', { amount: 5_000, idempotencyKey: KEY }, request);
    expect(service.deposit).toHaveBeenCalledWith(ANA, 'p1', 5_000, KEY);
    await controller.withdraw('p1', { amount: 2_000, idempotencyKey: KEY }, request);
    expect(service.withdraw).toHaveBeenCalledWith(ANA, 'p1', 2_000, KEY);
    await controller.close('p1', { idempotencyKey: KEY }, request);
    expect(service.withdraw).toHaveBeenLastCalledWith(ANA, 'p1', null, KEY, true);
    await controller.collect('c1', { idempotencyKey: KEY }, request);
    expect(service.collectCdt).toHaveBeenCalledWith(ANA, 'c1', KEY);
  });

  it('el catálogo de tasas y topes es público', () => {
    expect(guardsOf(SavingsCatalogController)).toEqual([]);
    expect(new SavingsCatalogController().catalog()).toEqual(savingsCatalog());
  });

  it('el resumen para la cancelación de la cuenta exige la clave interna', () => {
    expect(guardsOf(InternalSavingsController)).toContain(InternalKeyGuard);
  });
});
