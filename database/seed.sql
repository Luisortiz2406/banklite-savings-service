-- Datos de ejemplo de savings_db (savings-service). Escenario de demo compartido por todos
-- los microservicios (mismos UUID): Ana Pérez y Carlos Gómez, clientes de prueba,
-- y una cuenta de comercio. Datos inventados: no son personas ni documentos reales.
-- Cargar después del esquema:  psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
-- (si la base ya tiene estas filas, ON CONFLICT DO NOTHING las deja como están)

BEGIN;

INSERT INTO public.pockets (id, id_user, account_id, kind, name, icon, balance, earned, target, target_date, last_accrual_at, status, created_at) VALUES
  ('3f000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '3a000000-0000-4000-8000-000000000001', 'pocket', 'Vacaciones', 'viaje', 200000, 0, NULL, NULL, '2026-10-03 10:00:00-05', 'active', '2026-10-03 10:00:00-05'),
  ('3f000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '3a000000-0000-4000-8000-000000000001', 'goal', 'Computador nuevo', 'tecnologia', 0, 0, 2500000, '2027-06-30', '2026-10-03 10:00:00-05', 'active', '2026-10-03 10:00:00-05')
ON CONFLICT DO NOTHING;

INSERT INTO public.savings_ops (id, id_user, type, pocket_id, amount, idempotency_key, status, ledger_transaction_id, created_at, updated_at) VALUES
  ('3f000000-0000-4000-8000-0000000000c1', '11111111-1111-4111-8111-111111111111', 'pocket_in', '3f000000-0000-4000-8000-000000000001', 200000, '7c000000-0000-4000-8000-000000000003', 'completed', '7b000000-0000-4000-8000-000000000003', '2026-10-03 10:00:00-05', '2026-10-03 10:00:00-05')
ON CONFLICT DO NOTHING;

COMMIT;
