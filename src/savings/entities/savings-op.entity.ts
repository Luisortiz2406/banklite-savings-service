import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * Cada movimiento de plata del ahorro es una operación con su clave de
 * idempotencia (la misma que se manda al ledger). pending: lo reservado ya se
 * descontó aquí y falta el asiento del ledger; completed: hecho; failed: el
 * ledger lo rechazó y se revirtió lo reservado.
 */
export type SavingsOpType =
  'pocket_in' | 'pocket_out' | 'pocket_interest' | 'cdt_open' | 'cdt_principal' | 'cdt_interest';

@Entity('savings_ops')
@Index('idx_savings_ops_user_status', ['idUser', 'status'])
export class SavingsOp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ type: 'varchar', length: 16 })
  type: SavingsOpType;

  @Column({ name: 'pocket_id', type: 'uuid', nullable: true })
  pocketId: string | null;

  @Column({ name: 'cdt_id', type: 'uuid', nullable: true })
  cdtId: string | null;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  // Sacar todo y cerrar el bolsillo/meta cuando el asiento quede hecho.
  @Column({ name: 'close_pocket', default: false })
  closePocket: boolean;

  @Index('uq_savings_ops_idempotency', { unique: true })
  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey: string;

  @Column({ type: 'varchar', length: 10 })
  status: 'pending' | 'completed' | 'failed';

  @Column({ name: 'ledger_transaction_id', type: 'uuid', nullable: true })
  ledgerTransactionId: string | null;

  @Column({ name: 'failure_reason', type: 'varchar', length: 200, nullable: true })
  failureReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
