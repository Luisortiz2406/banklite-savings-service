import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { DataSource, EntitySchema } from 'typeorm';

/**
 * Base temporal de PostgreSQL para las pruebas que dependen de la base real
 * (transacciones, bloqueos e índices únicos no se pueden simular con mocks).
 *
 * TEST_DATABASE_URL: conexión con permiso para crear bases, p. ej.
 * postgres://postgres:postgres@localhost:5432/postgres (en CI la pone el workflow).
 * Sin ella las pruebas se omiten en local y fallan en CI.
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL;
if (!ADMIN_URL && process.env.CI) throw new Error('TEST_DATABASE_URL es obligatoria en CI.');

export const describeWithDb: jest.Describe = ADMIN_URL ? describe : describe.skip;
if (!ADMIN_URL)
  new Logger('Pruebas').warn('TEST_DATABASE_URL no está definida: se omiten las pruebas con base de datos.');

async function admin(sql: string) {
  const client = new Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type EntityTarget = Function | EntitySchema;

/** Crea una base vacía, sincroniza las entidades y devuelve cómo borrarla al final. */
export async function createTestDatabase(prefix: string, entities: EntityTarget[]) {
  const name = `${prefix}_test_${process.pid}_${Date.now()}`;
  await admin(`CREATE DATABASE ${name}`);
  const url = new URL(ADMIN_URL!);
  url.pathname = `/${name}`;
  const dataSource = new DataSource({
    type: 'postgres',
    url: url.toString(),
    entities,
    synchronize: true,
    extra: { max: 20 },
  });
  await dataSource.initialize();
  return {
    dataSource,
    async drop() {
      await dataSource.destroy();
      await admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    },
  };
}

/** Vacía las tablas entre pruebas. */
export async function truncateAll(dataSource: DataSource) {
  const tables = dataSource.entityMetadatas.map((m) => `"${m.tableName}"`).join(', ');
  await dataSource.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
