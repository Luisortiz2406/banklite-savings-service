import * as amqplib from 'amqplib';
import { ConfigService } from '@nestjs/config';
import { AccountClosedService } from '../savings/account-closed.service';
import { AccountClosedConsumer } from './account-closed.consumer';

jest.mock('amqplib', () => ({ connect: jest.fn() }));

/**
 * Mensajes de account.closed (RabbitMQ simulado): al cancelarse la cuenta se cierran los
 * bolsillos y metas vacíos. Lo que falle va a reintento o a la DLQ; procesarlo dos veces es inofensivo.
 */
const ANA = '11111111-1111-4111-8111-111111111111';

function fakeBroker() {
  const handlers: {
    connection: Record<string, (...args: any[]) => void>;
    channel: Record<string, (...args: any[]) => void>;
  } = { connection: {}, channel: {} };
  const channel = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.channel[event] = handler)),
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn().mockResolvedValue(undefined),
    sendToQueue: jest.fn(),
    ack: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const connection = {
    on: jest.fn((event: string, handler: (...args: any[]) => void) => (handlers.connection[event] = handler)),
    createChannel: jest.fn().mockResolvedValue(channel),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { channel, connection, handlers };
}
const delivery = (body: unknown) =>
  ({
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { routingKey: 'account.closed' },
    properties: { headers: {}, contentType: 'application/json', messageId: 'm1' },
  }) as unknown as amqplib.ConsumeMessage;

describe('AccountClosedConsumer: mensajes', () => {
  const connect = amqplib.connect as unknown as jest.Mock;
  let broker: ReturnType<typeof fakeBroker>;
  const closures = { handleAccountClosed: jest.fn() };

  const started = async (env: Record<string, string> = { RABBITMQ_URL: 'amqp://banklite:clave@rabbit' }) => {
    const consumer = new AccountClosedConsumer(
      { get: (key: string, fallback?: string) => env[key] ?? fallback } as unknown as ConfigService,
      closures as unknown as AccountClosedService,
    );
    await consumer.onModuleInit();
    const onMessage = broker.channel.consume.mock.calls[0][1] as (msg: amqplib.ConsumeMessage | null) => Promise<void>;
    const queue = broker.channel.consume.mock.calls[0][0] as string;
    return { consumer, onMessage, queue };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    broker = fakeBroker();
    connect.mockResolvedValue(broker.connection);
    closures.handleAccountClosed.mockResolvedValue(undefined);
  });
  afterEach(() => jest.useRealTimers());

  it('se suscribe solo a account.closed, con su cola de reintentos y DLQ, y el estado pasa a conectado', async () => {
    const { consumer, queue } = await started();

    expect(broker.channel.bindQueue).toHaveBeenCalledTimes(1);
    expect(broker.channel.bindQueue).toHaveBeenCalledWith(queue, 'banklite.events', 'account.closed');
    expect(broker.channel.assertQueue).toHaveBeenCalledWith(`${queue}.dlq`, { durable: true });
    expect(consumer.eventsState()).toBe('conectado');
  });

  it('al cancelarse la cuenta cierra lo del cliente y confirma el mensaje', async () => {
    const { onMessage } = await started();
    const msg = delivery({ event: 'account.closed', data: { idUser: ANA } });

    await onMessage(msg);

    expect(closures.handleAccountClosed).toHaveBeenCalledWith(ANA);
    expect(broker.channel.ack).toHaveBeenCalledWith(msg);
  });

  it('sin un idUser válido se descarta (se confirma para no bloquear la cola) y no cierra nada', async () => {
    const { onMessage } = await started();

    for (const data of [{}, { idUser: 'abc' }, { idUser: 42 }, undefined]) {
      const msg = delivery({ data });
      await onMessage(msg);
      expect(broker.channel.ack).toHaveBeenLastCalledWith(msg);
    }

    expect(closures.handleAccountClosed).not.toHaveBeenCalled();
    expect(broker.channel.sendToQueue).not.toHaveBeenCalled();
  });

  it('un mensaje que no es JSON va a la DLQ; si cerrar falla, va a la cola de espera para reintentar', async () => {
    const { onMessage, queue } = await started();

    await onMessage(delivery('esto no es json'));
    expect(broker.channel.sendToQueue.mock.calls[0][0]).toBe(`${queue}.dlq`);

    closures.handleAccountClosed.mockRejectedValueOnce(new Error('base caída'));
    await onMessage(delivery({ data: { idUser: ANA } }));
    expect(broker.channel.sendToQueue.mock.calls[1][0]).toBe(`${queue}.retry`);

    await onMessage(null);
  });

  it('si la conexión se cae, el estado pasa a sin_conexion y reconecta a los 5 s; cerrar el módulo cancela el reintento', async () => {
    jest.useFakeTimers();
    const { consumer } = await started();

    broker.handlers.connection.close();
    expect(consumer.eventsState()).toBe('sin_conexion');
    await jest.advanceTimersByTimeAsync(5_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(consumer.eventsState()).toBe('conectado');

    broker.handlers.connection.close();
    await consumer.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(20_000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(() => broker.handlers.connection.error(new Error('x'))).not.toThrow();
    expect(() => broker.handlers.channel.error(new Error('x'))).not.toThrow();
  });
});
