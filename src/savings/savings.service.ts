import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomInt } from 'crypto';
import { DataSource, In, LessThan, Repository } from 'typeorm';
import {
  CDT_MIN,
  CDT_TAX,
  CDT_TERMS,
  cdtResult,
  DAY_MS,
  GOAL_ICONS,
  GOAL_MIN_TARGET,
  interestFor,
  MAX_GOALS,
  MAX_POCKETS,
  MIN_MOVE,
  POCKET_ICONS,
  POCKET_RATE,
} from './catalog';
import { Cdt } from './entities/cdt.entity';
import { Pocket, PocketKind } from './entities/pocket.entity';
import { SavingsOp, SavingsOpType } from './entities/savings-op.entity';
import { LedgerError, SavingsClientsService, SavingsLedgerKind } from './savings-clients.service';

const STALE_PENDING_MS = 30_000;
const money = (value: number | string) => Math.round(Number(value) * 100) / 100;
const label = (kind: PocketKind) => (kind === 'goal' ? 'meta' : 'bolsillo');

/** UUID determinista a partir de otra clave (sub-operaciones de un mismo pedido). */
function derivedKey(base: string, suffix: string): string {
  const h = createHash('sha256').update(`${base}|${suffix}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

@Injectable()
export class SavingsService {
  private readonly logger = new Logger('Savings');

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    @InjectRepository(Pocket) private readonly pockets: Repository<Pocket>,
    @InjectRepository(Cdt) private readonly cdts: Repository<Cdt>,
    @InjectRepository(SavingsOp) private readonly ops: Repository<SavingsOp>,
    private readonly clients: SavingsClientsService,
  ) {}

  // =====================================================
  // RESUMEN
  // =====================================================

  async summary(idUser: string) {
    await this.resumeStale(idUser);
    const [pockets, cdts] = await Promise.all([
      this.pockets.find({ where: { idUser }, order: { createdAt: 'ASC' } }),
      this.cdts.find({ where: { idUser, status: In(['active', 'collecting', 'paid']) }, order: { createdAt: 'DESC' } }),
    ]);
    const active = pockets.filter((p) => p.status === 'active');
    const view = active.map((p) => this.publicPocket(p));
    const sum = (list: { balance: number }[]) => money(list.reduce((t, x) => t + x.balance, 0));
    const interestEarned = money(
      pockets.reduce((t, p) => t + Number(p.earned), 0) +
        view.reduce((t, p) => t + p.accrued, 0) +
        cdts.filter((c) => c.status === 'paid').reduce((t, c) => t + Number(c.net), 0),
    );
    return {
      pockets: view.filter((p) => p.kind === 'pocket'),
      goals: view.filter((p) => p.kind === 'goal'),
      cdts: cdts.map((c) => this.publicCdt(c)),
      totals: {
        inPockets: sum(view.filter((p) => p.kind === 'pocket')),
        inGoals: sum(view.filter((p) => p.kind === 'goal')),
        inCdts: money(cdts.filter((c) => c.status !== 'paid').reduce((t, c) => t + Number(c.amount), 0)),
        interestEarned,
      },
      // Para los retos de Puntos Banklite (rewards-service).
      milestones: {
        hasPocket:
          pockets.some((p) => p.kind === 'pocket' && Number(p.balance) > 0) ||
          (await this.hasCompletedOp(idUser, 'pocket_in')),
        hasCdt: cdts.length > 0,
      },
      config: {
        pocketRate: POCKET_RATE,
        cdtMin: CDT_MIN,
        cdtTax: CDT_TAX,
        cdtTerms: CDT_TERMS,
        minMove: MIN_MOVE,
        pocketIcons: POCKET_ICONS,
        goalIcons: GOAL_ICONS,
        demoMaturity: this.demoMaturityEnabled(),
      },
    };
  }

  // =====================================================
  // BOLSILLOS Y METAS
  // =====================================================

  async createPocket(
    idUser: string,
    token: string,
    dto: { kind: PocketKind; name: string; icon: string; target?: number; targetDate?: string },
  ) {
    const name = dto.name.trim();
    if (name.length < 2) throw new BadRequestException(`Ponle un nombre a tu ${label(dto.kind)}.`);
    const icons = dto.kind === 'goal' ? GOAL_ICONS : POCKET_ICONS;
    if (!icons.includes(dto.icon)) throw new BadRequestException('Ícono no válido.');
    if (dto.kind === 'goal') {
      if (!dto.target || dto.target < GOAL_MIN_TARGET)
        throw new BadRequestException('La meta debe ser de al menos $10.000.');
      if (dto.targetDate && dto.targetDate <= new Date().toISOString().slice(0, 10)) {
        throw new BadRequestException('La fecha de la meta debe ser futura.');
      }
    }
    const active = await this.pockets.find({ where: { idUser, kind: dto.kind, status: 'active' } });
    if (active.length >= (dto.kind === 'goal' ? MAX_GOALS : MAX_POCKETS)) {
      throw new BadRequestException(
        dto.kind === 'goal'
          ? `Puedes tener máximo ${MAX_GOALS} metas.`
          : `Puedes tener máximo ${MAX_POCKETS} bolsillos.`,
      );
    }
    if (active.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new ConflictException(`Ya tienes un ${label(dto.kind)} con ese nombre.`);
    }
    const account = await this.clients.receivingAccount(token);
    if (!account) throw new BadRequestException('Necesitas una cuenta Banklite activa.');
    const pocket = await this.pockets.save(
      this.pockets.create({
        idUser,
        accountId: account.id,
        kind: dto.kind,
        name,
        icon: dto.icon,
        balance: '0',
        earned: '0',
        target: dto.kind === 'goal' ? money(dto.target).toFixed(2) : null,
        targetDate: dto.kind === 'goal' ? (dto.targetDate ?? null) : null,
        lastAccrualAt: new Date(),
        status: 'active',
        closedAt: null,
      }),
    );
    return this.publicPocket(pocket);
  }

  /** Agregar plata (sale del saldo disponible hacia la custodia). */
  async deposit(idUser: string, pocketId: string, amount: number, key: string) {
    const replay = await this.replay(key, idUser);
    if (replay) return replay;
    const pocket = await this.ownedPocket(idUser, pocketId);
    this.assertAmount(amount);
    // Los intereses causados se capitalizan antes de cambiar el saldo.
    await this.capitalize(pocket);
    const op = await this.newOp({ idUser, type: 'pocket_in', pocketId, amount, key });
    return this.execute(op);
  }

  /** Sacar plata (vuelve al saldo disponible). Con close=true saca todo y cierra. */
  async withdraw(idUser: string, pocketId: string, amount: number | null, key: string, close = false) {
    const replay = await this.replay(key, idUser);
    if (replay) return replay;
    const pocket = await this.ownedPocket(idUser, pocketId);
    await this.capitalize(pocket);

    const op = await this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOne(Pocket, { where: { id: pocketId }, lock: { mode: 'pessimistic_write' } });
      const balance = Number(locked.balance);
      const take = close ? balance : money(amount ?? 0);
      if (!close) this.assertAmount(take);
      if (take > balance)
        throw new BadRequestException(`En este ${label(locked.kind)} tienes ${balance.toLocaleString('es-CO')}.`);
      if (take <= 0) {
        // Nada que devolver: se cierra de una vez.
        locked.status = 'closed';
        locked.closedAt = new Date();
        await manager.save(locked);
        return null;
      }
      // Se reserva: el saldo del bolsillo baja ya; si el ledger lo rechaza, se devuelve.
      locked.balance = money(balance - take).toFixed(2);
      await manager.save(locked);
      return manager.save(
        manager.create(SavingsOp, {
          idUser,
          type: 'pocket_out',
          pocketId,
          cdtId: null,
          amount: take.toFixed(2),
          closePocket: close,
          idempotencyKey: key,
          status: 'pending',
          ledgerTransactionId: null,
          failureReason: null,
        }),
      );
    });
    if (!op)
      return { status: 'completed', pocket: this.publicPocket(await this.pockets.findOneByOrFail({ id: pocketId })) };
    return this.execute(op);
  }

  // =====================================================
  // CDT
  // =====================================================

  async openCdt(idUser: string, token: string, amount: number, days: number, key: string) {
    const replay = await this.replay(key, idUser);
    if (replay) return replay;
    const term = CDT_TERMS.find((t) => t.days === days);
    if (!term) throw new BadRequestException('Ese plazo no está disponible.');
    if (!Number.isInteger(amount) || amount < CDT_MIN) {
      throw new BadRequestException(`El monto mínimo para un CDT es $${CDT_MIN.toLocaleString('es-CO')}.`);
    }
    const account = await this.clients.receivingAccount(token);
    if (!account) throw new BadRequestException('Necesitas una cuenta Banklite activa.');
    const result = cdtResult(amount, term.rate, term.days);
    const now = new Date();

    const op = await this.dataSource.transaction(async (manager) => {
      const cdt = await manager.save(
        manager.create(Cdt, {
          idUser,
          accountId: account.id,
          number: `CDT${randomInt(1_000_000, 9_999_999)}`,
          amount: amount.toFixed(2),
          days: term.days,
          rate: term.rate.toFixed(4),
          gross: result.gross.toFixed(2),
          tax: result.tax.toFixed(2),
          net: result.net.toFixed(2),
          openedAt: now,
          maturesAt: new Date(now.getTime() + term.days * DAY_MS),
          status: 'opening',
          paidAt: null,
        }),
      );
      return manager.save(
        manager.create(SavingsOp, {
          idUser,
          type: 'cdt_open',
          pocketId: null,
          cdtId: cdt.id,
          amount: amount.toFixed(2),
          closePocket: false,
          idempotencyKey: key,
          status: 'pending',
          ledgerTransactionId: null,
          failureReason: null,
        }),
      );
    });
    return this.execute(op);
  }

  /** Cobrar un CDT vencido: vuelve el capital y el banco paga los intereses netos. */
  async collectCdt(idUser: string, cdtId: string, key: string) {
    const replay = await this.replay(key, idUser);
    if (replay) return replay;
    const cdt = await this.cdts.findOne({ where: { id: cdtId, idUser } });
    if (!cdt) throw new NotFoundException('CDT no encontrado.');
    if (cdt.status === 'paid') return { status: 'completed', cdt: this.publicCdt(cdt) };
    if (cdt.status !== 'active' && cdt.status !== 'collecting')
      throw new ConflictException('Ese CDT no se puede cobrar.');
    if (Date.now() < cdt.maturesAt.getTime()) throw new BadRequestException('Tu CDT todavía no ha vencido.');

    const [principal, interest] = await this.dataSource.transaction(async (manager) => {
      await manager.update(Cdt, { id: cdt.id, status: 'active' }, { status: 'collecting' });
      const make = (type: SavingsOpType, amount: string, opKey: string) =>
        manager.save(
          manager.create(SavingsOp, {
            idUser,
            type,
            pocketId: null,
            cdtId: cdt.id,
            amount,
            closePocket: false,
            idempotencyKey: opKey,
            status: 'pending',
            ledgerTransactionId: null,
            failureReason: null,
          }),
        );
      const existing = await manager.find(SavingsOp, {
        where: { cdtId: cdt.id, type: In(['cdt_principal', 'cdt_interest']) },
      });
      return [
        existing.find((o) => o.type === 'cdt_principal') ?? (await make('cdt_principal', cdt.amount, key)),
        existing.find((o) => o.type === 'cdt_interest') ??
          (await make('cdt_interest', cdt.net, derivedKey(key, 'interest'))),
      ];
    });
    if (principal.status !== 'completed') await this.execute(principal);
    if (interest.status !== 'completed' && Number(interest.amount) > 0) await this.execute(interest);
    await this.finishCdtIfPaid(cdt.id);
    return { status: 'completed', cdt: this.publicCdt(await this.cdts.findOneByOrFail({ id: cdt.id })) };
  }

  /** Solo demostración (ENABLE_DEMO_MATURITY=true): adelanta el vencimiento a hoy. */
  async demoMature(idUser: string, cdtId: string) {
    if (!this.demoMaturityEnabled()) throw new ForbiddenException('La simulación de vencimiento no está habilitada.');
    const cdt = await this.cdts.findOne({ where: { id: cdtId, idUser, status: 'active' } });
    if (!cdt) throw new NotFoundException('CDT no encontrado.');
    const shift = cdt.maturesAt.getTime() - Date.now();
    cdt.openedAt = new Date(cdt.openedAt.getTime() - shift);
    cdt.maturesAt = new Date();
    await this.cdts.save(cdt);
    return this.publicCdt(cdt);
  }

  // =====================================================
  // OPERACIONES: ledger + aplicar / revertir
  // =====================================================

  private async execute(op: SavingsOp): Promise<any> {
    const target = op.pocketId
      ? await this.pockets.findOneByOrFail({ id: op.pocketId })
      : await this.cdts.findOneByOrFail({ id: op.cdtId });
    const ledgerKind: Record<SavingsOpType, SavingsLedgerKind> = {
      pocket_in: 'to_custody',
      pocket_out: 'from_custody',
      pocket_interest: 'interest_to_custody',
      cdt_open: 'to_custody',
      cdt_principal: 'from_custody',
      cdt_interest: 'interest_to_account',
    };
    try {
      const transaction = await this.clients.post({
        kind: ledgerKind[op.type],
        product: op.cdtId ? 'cdt' : 'pocket',
        accountId: target.accountId,
        idUser: op.idUser,
        amount: Number(op.amount),
        idempotencyKey: op.idempotencyKey,
        description: this.describe(op, target),
      });
      await this.complete(op, transaction.id);
    } catch (error) {
      if (error instanceof LedgerError && error.definitive) {
        await this.fail(op, error.message);
        throw new BadRequestException(error.message);
      }
      if (error instanceof LedgerError) {
        this.logger.warn(`Operación ${op.id} pendiente: ${error.message}`);
        throw new ServiceUnavailableException('Estamos confirmando la operación. Revisa en unos segundos.');
      }
      throw error;
    }
    const fresh = await this.ops.findOneByOrFail({ id: op.id });
    return {
      status: fresh.status,
      operationId: fresh.id,
      ledgerTransactionId: fresh.ledgerTransactionId,
      pocket: op.pocketId ? this.publicPocket(await this.pockets.findOneByOrFail({ id: op.pocketId })) : undefined,
      cdt: op.cdtId ? this.publicCdt(await this.cdts.findOneByOrFail({ id: op.cdtId })) : undefined,
    };
  }

  /** El asiento quedó: se marca la operación y se aplica su efecto (una sola vez). */
  private async complete(op: SavingsOp, ledgerTransactionId: string) {
    await this.dataSource.transaction(async (manager) => {
      const claimed = await manager.update(
        SavingsOp,
        { id: op.id, status: 'pending' },
        { status: 'completed', ledgerTransactionId },
      );
      if (!claimed.affected) return;
      const amount = Number(op.amount);
      if (op.type === 'pocket_in' || op.type === 'pocket_interest') {
        const pocket = await manager.findOne(Pocket, {
          where: { id: op.pocketId },
          lock: { mode: 'pessimistic_write' },
        });
        pocket.balance = money(Number(pocket.balance) + amount).toFixed(2);
        if (op.type === 'pocket_interest') pocket.earned = money(Number(pocket.earned) + amount).toFixed(2);
        await manager.save(pocket);
      }
      if (op.type === 'pocket_out' && op.closePocket) {
        await manager.update(Pocket, { id: op.pocketId }, { status: 'closed', closedAt: new Date() });
      }
      if (op.type === 'cdt_open') await manager.update(Cdt, { id: op.cdtId, status: 'opening' }, { status: 'active' });
    });
    if (op.type === 'cdt_principal' || op.type === 'cdt_interest') await this.finishCdtIfPaid(op.cdtId);
  }

  /** El ledger lo rechazó: se revierte lo reservado (compensación). */
  private async fail(op: SavingsOp, reason: string) {
    await this.dataSource.transaction(async (manager) => {
      const claimed = await manager.update(
        SavingsOp,
        { id: op.id, status: 'pending' },
        { status: 'failed', failureReason: reason.slice(0, 200) },
      );
      if (!claimed.affected) return;
      if (op.type === 'pocket_out') {
        const pocket = await manager.findOne(Pocket, {
          where: { id: op.pocketId },
          lock: { mode: 'pessimistic_write' },
        });
        pocket.balance = money(Number(pocket.balance) + Number(op.amount)).toFixed(2);
        await manager.save(pocket);
      }
      if (op.type === 'cdt_open') await manager.update(Cdt, { id: op.cdtId }, { status: 'failed' });
      if (op.type === 'cdt_principal') {
        await manager.update(Cdt, { id: op.cdtId, status: 'collecting' }, { status: 'active' });
        // El interés no se paga si el capital no volvió; se podrá cobrar de nuevo.
        await manager.delete(SavingsOp, {
          cdtId: op.cdtId,
          type: In(['cdt_principal', 'cdt_interest']),
          status: In(['pending', 'failed']),
        });
      }
    });
  }

  private async finishCdtIfPaid(cdtId: string) {
    const ops = await this.ops.find({ where: { cdtId, type: In(['cdt_principal', 'cdt_interest']) } });
    const cdt = await this.cdts.findOneByOrFail({ id: cdtId });
    const principal = ops.find((o) => o.type === 'cdt_principal');
    const interest = ops.find((o) => o.type === 'cdt_interest');
    const interestDone = Number(cdt.net) <= 0 || interest?.status === 'completed';
    if (principal?.status === 'completed' && interestDone && cdt.status !== 'paid') {
      await this.cdts.update({ id: cdtId }, { status: 'paid', paidAt: new Date() });
    }
  }

  /** Capitaliza los intereses causados de un bolsillo (las metas no rentan). */
  private async capitalize(pocket: Pocket) {
    if (pocket.kind !== 'pocket') return;
    const op = await this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOne(Pocket, { where: { id: pocket.id }, lock: { mode: 'pessimistic_write' } });
      const days = (Date.now() - locked.lastAccrualAt.getTime()) / DAY_MS;
      const accrued = interestFor(Number(locked.balance), POCKET_RATE, days);
      if (accrued < 0.01) return null;
      locked.lastAccrualAt = new Date();
      await manager.save(locked);
      return manager.save(
        manager.create(SavingsOp, {
          idUser: locked.idUser,
          type: 'pocket_interest',
          pocketId: locked.id,
          cdtId: null,
          amount: accrued.toFixed(2),
          closePocket: false,
          idempotencyKey: derivedKey(locked.id, `interest-${locked.lastAccrualAt.toISOString()}`),
          status: 'pending',
          ledgerTransactionId: null,
          failureReason: null,
        }),
      );
    });
    if (op) await this.execute(op);
  }

  private async resumeStale(idUser: string) {
    const stale = await this.ops.find({
      where: { idUser, status: 'pending', updatedAt: LessThan(new Date(Date.now() - STALE_PENDING_MS)) },
    });
    for (const op of stale) await this.execute(op).catch(() => undefined);
  }

  // =====================================================
  // AUXILIARES
  // =====================================================

  /** Misma clave de idempotencia = misma operación (doble clic o reintento). */
  private async replay(key: string, idUser: string) {
    const op = await this.ops.findOne({ where: { idempotencyKey: key } });
    if (!op) return null;
    if (op.idUser !== idUser) throw new ConflictException('La clave de idempotencia ya se usó.');
    if (op.status === 'failed') throw new ConflictException(op.failureReason || 'Esa operación no se pudo completar.');
    if (op.status === 'pending') return this.execute(op);
    return {
      status: op.status,
      operationId: op.id,
      ledgerTransactionId: op.ledgerTransactionId,
      pocket: op.pocketId ? this.publicPocket(await this.pockets.findOneByOrFail({ id: op.pocketId })) : undefined,
      cdt: op.cdtId ? this.publicCdt(await this.cdts.findOneByOrFail({ id: op.cdtId })) : undefined,
    };
  }

  private async newOp(p: { idUser: string; type: SavingsOpType; pocketId: string; amount: number; key: string }) {
    try {
      return await this.ops.save(
        this.ops.create({
          idUser: p.idUser,
          type: p.type,
          pocketId: p.pocketId,
          cdtId: null,
          amount: money(p.amount).toFixed(2),
          closePocket: false,
          idempotencyKey: p.key,
          status: 'pending',
          ledgerTransactionId: null,
          failureReason: null,
        }),
      );
    } catch (error) {
      if ((error as any)?.code === '23505') {
        const raced = await this.ops.findOne({ where: { idempotencyKey: p.key } });
        if (raced) return raced;
      }
      throw error;
    }
  }

  private async ownedPocket(idUser: string, pocketId: string) {
    const pocket = await this.pockets.findOne({ where: { id: pocketId, idUser } });
    if (!pocket || pocket.status !== 'active') throw new NotFoundException('Bolsillo o meta no encontrado.');
    return pocket;
  }

  private assertAmount(amount: number) {
    if (!Number.isFinite(amount) || amount < MIN_MOVE) throw new BadRequestException('El valor mínimo es $1.000.');
  }

  private async hasCompletedOp(idUser: string, type: SavingsOpType) {
    return this.ops.exist({ where: { idUser, type, status: 'completed' } });
  }

  private describe(op: SavingsOp, target: Pocket | Cdt): string {
    if ('kind' in target) {
      const what = target.kind === 'goal' ? 'meta' : 'bolsillo';
      if (op.type === 'pocket_in') return `Dinero a ${what} · ${target.name}`;
      if (op.type === 'pocket_out') return `Retiro de ${what} · ${target.name}`;
      return `Intereses de bolsillo · ${target.name}`;
    }
    const cdt = target as Cdt;
    const rate = `${(Number(cdt.rate) * 100).toLocaleString('es-CO', { maximumFractionDigits: 1 })}% E.A.`;
    if (op.type === 'cdt_open') return `Apertura de CDT · ${cdt.number} · ${cdt.days} días · ${rate}`;
    if (op.type === 'cdt_principal') return `Vencimiento de CDT · ${cdt.number} · Capital`;
    return `Intereses de CDT · ${cdt.number} · menos retención`;
  }

  private demoMaturityEnabled() {
    return this.config.get<string>('ENABLE_DEMO_MATURITY') === 'true';
  }

  private publicPocket(p: Pocket) {
    const balance = Number(p.balance);
    const days = (Date.now() - p.lastAccrualAt.getTime()) / DAY_MS;
    const accrued = p.kind === 'pocket' ? interestFor(balance, POCKET_RATE, days) : 0;
    const total = money(balance + accrued);
    return {
      id: p.id,
      kind: p.kind,
      name: p.name,
      icon: p.icon,
      balance: total,
      accrued,
      earned: money(Number(p.earned) + accrued),
      rate: p.kind === 'pocket' ? POCKET_RATE : 0,
      target: p.target === null ? null : Number(p.target),
      targetDate: p.targetDate,
      completed: p.target !== null && total >= Number(p.target),
      createdAt: p.createdAt,
    };
  }

  private publicCdt(c: Cdt) {
    return {
      id: c.id,
      number: c.number,
      amount: Number(c.amount),
      days: c.days,
      rate: Number(c.rate),
      gross: Number(c.gross),
      tax: Number(c.tax),
      net: Number(c.net),
      total: money(Number(c.amount) + Number(c.net)),
      openedAt: c.openedAt,
      maturesAt: c.maturesAt,
      matured: Date.now() >= c.maturesAt.getTime(),
      status: c.status,
      paidAt: c.paidAt,
    };
  }
}
