import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import { Cdt } from './entities/cdt.entity';
import { Pocket } from './entities/pocket.entity';
import { SavingsOp } from './entities/savings-op.entity';

// CDT que todavía tienen dinero del cliente (abriéndose, vigentes o pagándose).
const CDT_VIGENTES: Cdt['status'][] = ['opening', 'active', 'collecting'];

export interface ClosureSummary {
  bolsillosConDinero: number;
  metasConDinero: number;
  // Lo que el cliente tiene apartado en bolsillos y metas (sin intereses causados).
  saldoApartado: number;
  cdtsVigentes: number;
  operacionesEnProceso: number;
  // true si nada del ahorro impide cancelar la cuenta.
  sinPendientes: boolean;
}

/**
 * Resumen de lo que el ahorro del cliente impediría al cancelar su cuenta
 * (lo pide account-service antes de cerrarla). Solo lectura.
 */
@Injectable()
export class ClosureSummaryService {
  constructor(
    @InjectRepository(Pocket) private readonly pockets: Repository<Pocket>,
    @InjectRepository(Cdt) private readonly cdts: Repository<Cdt>,
    @InjectRepository(SavingsOp) private readonly ops: Repository<SavingsOp>,
  ) {}

  async summary(idUser: string): Promise<ClosureSummary> {
    const [conDinero, cdtsVigentes, operacionesEnProceso] = await Promise.all([
      this.pockets.find({ where: { idUser, status: 'active', balance: MoreThan('0') } }),
      this.cdts.count({ where: { idUser, status: In(CDT_VIGENTES) } }),
      this.ops.count({ where: { idUser, status: 'pending' } }),
    ]);
    const bolsillosConDinero = conDinero.filter((p) => p.kind === 'pocket').length;
    const metasConDinero = conDinero.filter((p) => p.kind === 'goal').length;
    const saldoApartado = Number(conDinero.reduce((sum, p) => sum + Number(p.balance), 0).toFixed(2));
    return {
      bolsillosConDinero,
      metasConDinero,
      saldoApartado,
      cdtsVigentes,
      operacionesEnProceso,
      sinPendientes: conDinero.length === 0 && cdtsVigentes === 0 && operacionesEnProceso === 0,
    };
  }
}
