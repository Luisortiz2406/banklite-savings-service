import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * CDT: el capital queda en la custodia de CDT hasta el vencimiento. Al cobrarlo
 * vuelve el capital y el banco paga los intereses netos (menos retención).
 * opening: abriéndose; active: invertido; collecting: cobrándose; paid: pagado;
 * failed: no se pudo abrir (no se movió plata).
 */
export type CdtStatus = 'opening' | 'active' | 'collecting' | 'paid' | 'failed';

@Entity('cdts')
@Index('idx_cdts_user', ['idUser', 'status'])
export class Cdt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'id_user', type: 'uuid' })
  idUser: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Index('uq_cdts_number', { unique: true })
  @Column({ type: 'varchar', length: 12 })
  number: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  amount: string;

  @Column({ type: 'int' })
  days: number;

  @Column({ type: 'numeric', precision: 6, scale: 4 })
  rate: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  gross: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  tax: string;

  @Column({ type: 'numeric', precision: 18, scale: 2 })
  net: string;

  @Column({ name: 'opened_at', type: 'timestamptz' })
  openedAt: Date;

  @Column({ name: 'matures_at', type: 'timestamptz' })
  maturesAt: Date;

  @Column({ type: 'varchar', length: 10 })
  status: CdtStatus;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
