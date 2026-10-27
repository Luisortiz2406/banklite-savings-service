import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { HealthController } from '../health.controller';
import { AccountClosedService } from '../savings/account-closed.service';
import { AccountClosedConsumer, hasPassword } from './account-closed.consumer';

// Puerto 1 en localhost: nadie escucha, la conexión se rechaza al instante.
const UNREACHABLE = 'amqp://banklite:clave-de-prueba@127.0.0.1:1';

const consumerWith = (env: Record<string, string | undefined>) =>
  new AccountClosedConsumer(
    { get: (key: string, fallback?: string) => env[key] ?? fallback } as unknown as ConfigService,
    {} as AccountClosedService,
  );

describe('Conexión de savings con RabbitMQ: avisos y estado', () => {
  let warn: jest.SpyInstance;
  const consumers: AccountClosedConsumer[] = [];
  const make = (env: Record<string, string | undefined>) => {
    const c = consumerWith(env);
    consumers.push(c);
    return c;
  };

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((c) => c.onModuleDestroy()));
    jest.restoreAllMocks();
  });

  const warnings = () => warn.mock.calls.map((call) => String(call[0]));

  it('sin RABBITMQ_URL: avisa al arrancar y el estado es sin_configurar', async () => {
    const consumer = make({});
    await consumer.onModuleInit();
    expect(consumer.eventsState()).toBe('sin_configurar');
    expect(warnings()).toEqual([
      expect.stringContaining('RABBITMQ_URL no está configurada: NO se escucha account.closed'),
    ]);
  });

  it('URL con la contraseña vacía (lo que pasó en rewards): avisa antes de intentar', async () => {
    const consumer = make({ RABBITMQ_URL: 'amqp://banklite:@127.0.0.1:1' });
    await consumer.onModuleInit();
    expect(warnings()[0]).toContain('RABBITMQ_URL no tiene contraseña');
    expect(consumer.eventsState()).toBe('sin_conexion');
  });

  it('si no conecta: aviso claro al arrancar, estado sin_conexion, y el aviso se repite cada 60 intentos', async () => {
    const consumer = make({ RABBITMQ_URL: UNREACHABLE });
    await consumer.onModuleInit();
    expect(consumer.eventsState()).toBe('sin_conexion');
    expect(warnings()).toEqual([expect.stringContaining('Sin conexión con RabbitMQ')]);
    expect(warnings()[0]).toContain('account.closed NO se procesa');

    const connect = (consumer as unknown as { connect: () => Promise<void> }).connect.bind(consumer);
    for (let i = 2; i <= 60; i++) await connect();
    const avisos = warnings().filter((w) => w.includes('Sin conexión con RabbitMQ'));
    expect(avisos).toHaveLength(2);
    expect(avisos[1]).toContain('intento 60');
  });

  it.each([
    ['amqp://banklite:secreto@host:5672', true],
    ['amqp://banklite:%20x@host:5672', true],
    ['amqp://banklite:@host:5672', false],
    ['amqp://banklite@host:5672', false],
    ['no es una url', false],
  ])('hasPassword(%s) = %s', (url, expected) => {
    expect(hasPassword(url)).toBe(expected);
  });
});

describe('/health de savings con los eventos', () => {
  const dataSource = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
  const res = { status: jest.fn() } as unknown as Response;

  it.each(['sin_conexion', 'sin_configurar', 'conectado'] as const)(
    'eventos %s: el servicio sigue en ok (200)',
    async (state) => {
      const events = { eventsState: () => state } as AccountClosedConsumer;
      const health = new HealthController(dataSource as unknown as DataSource, events);
      const body = await health.check(res);
      expect(body).toMatchObject({ status: 'ok', database: 'ok', eventos: state });
      expect(res.status).not.toHaveBeenCalled();
    },
  );
});
