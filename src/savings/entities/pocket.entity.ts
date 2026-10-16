import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Bolsillo (rinde POCKET_RATE) o meta de ahorro (tiene objetivo y fecha, no
 * rinde). Su plata está en la cuenta de custodia del ledger, no en el saldo
 * disponible. `balance` no incluye los intereses que se van causando: esos se
 * calculan al vuelo y se capitalizan (con un asiento del ledger) al sacar plata.
 */
export type PocketKind = 'pocket' | 'goal';

@Entity('pockets')
@Index('idx_pockets_user', ['idUser', 'status'])
export class Pocket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  // Cuenta Banklite de donde sale y a donde vuelve la plata.
  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ type: 'varchar', length: 6 })
  kind: PocketKind;

  @Column({ type: 'varchar', length: 40 })
  name: string;

  @Column({ type: 'varchar', length: 20 })
  icon: string;

  @Column({ type: 'numeric', precision: 18, scale: 2, default: 0 })
  balance: string;

  // Intereses ya capitalizados.
  @Column({ type: 'numeric', precision: 18, scale: 2, default: 0 })
  earned: string;

  @Column({ type: 'numeric', precision: 18, scale: 2, nullable: true })
  target: string | null;

  @Column({ name: 'target_date', type: 'date', nullable: true })
  targetDate: string | null;

  @Column({ name: 'last_accrual_at', type: 'timestamptz' })
  lastAccrualAt: Date;

  @Column({ type: 'varchar', length: 8, default: 'active' })
  status: 'active' | 'closed';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt: Date | null;
}
