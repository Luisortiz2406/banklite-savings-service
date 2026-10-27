import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { Cdt } from './entities/cdt.entity';
import { Pocket } from './entities/pocket.entity';
import { SavingsOp } from './entities/savings-op.entity';

// Mismos estados que el resumen para cancelar: CDT que todavía tienen dinero del cliente.
const CDT_VIGENTES: Cdt['status'][] = ['opening', 'active', 'collecting'];

export interface AccountClosedResult {
  cerrados: number;
  conDinero: number;
  conOperacionEnProceso: number;
  cdtsVigentes: number;
}

/**
 * Cliente que canceló su cuenta (evento account.closed): cierra sus bolsillos y
 * metas activos que están en $0. Los que todavía tienen dinero o una operación en
 * proceso NO se tocan y quedan en el log para revisión (account ya exige que todo
 * esté en $0 antes de cerrar, así que no debería pasar). Los CDT no se tocan.
 *
 * Idempotente: solo actúa sobre los que siguen activos y en $0, así que procesar
 * el evento dos veces no cambia nada.
 */
@Injectable()
export class AccountClosedService {
  private readonly logger = new Logger('AccountClosedService');

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async handleAccountClosed(idUser: string): Promise<AccountClosedResult> {
    const result = await this.dataSource.transaction(async (manager) => {
      // Mismo bloqueo que usan los retiros y el abono de intereses: nada cambia el saldo mientras se decide.
      const pockets = await manager.find(Pocket, {
        where: { idUser, status: 'active' },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const pending = await manager.find(SavingsOp, { where: { idUser, status: 'pending' } });
      const pendingPockets = new Set(pending.map((op) => op.pocketId).filter((id): id is string => !!id));

      const result: AccountClosedResult = { cerrados: 0, conDinero: 0, conOperacionEnProceso: 0, cdtsVigentes: 0 };
      const toClose: string[] = [];
      for (const pocket of pockets) {
        if (Number(pocket.balance) > 0) {
          result.conDinero++;
          this.logger.warn(
            `Cuenta cancelada idUser=${idUser}: ${pocket.kind === 'goal' ? 'la meta' : 'el bolsillo'} ${pocket.id} tiene ${pocket.balance}; no se cierra.`,
          );
        } else if (pendingPockets.has(pocket.id)) {
          result.conOperacionEnProceso++;
          this.logger.warn(
            `Cuenta cancelada idUser=${idUser}: ${pocket.kind === 'goal' ? 'la meta' : 'el bolsillo'} ${pocket.id} tiene una operación en proceso; no se cierra.`,
          );
        } else {
          toClose.push(pocket.id);
        }
      }
      if (toClose.length) {
        await manager.update(Pocket, { id: In(toClose) }, { status: 'closed', closedAt: new Date() });
        result.cerrados = toClose.length;
      }

      result.cdtsVigentes = await manager.count(Cdt, { where: { idUser, status: In(CDT_VIGENTES) } });
      if (result.cdtsVigentes)
        this.logger.warn(`Cuenta cancelada idUser=${idUser}: ${result.cdtsVigentes} CDT vigente(s); no se tocan.`);
      return result;
    });
    this.logger.log(`Cuenta cancelada idUser=${idUser}: ${result.cerrados} bolsillo(s)/meta(s) vacío(s) cerrado(s).`);
    return result;
  }
}
