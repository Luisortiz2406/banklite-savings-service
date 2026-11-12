import type { Logger } from '@nestjs/common';
import type * as amqplib from 'amqplib';
import { assertRetryQueues, handleFailure, originalRoutingKey, PoisonMessageError } from './retry-policy';

/**
 * Reintentos de los eventos de RabbitMQ: un evento que falla espera y se reintenta, y si
 * agota los intentos (o es basura) va a la DLQ para revisión; nunca se pierde ni bloquea la cola.
 */
const QUEUE = 'servicio.eventos';
const logger = { warn: jest.fn(), error: jest.fn() } as unknown as Logger & { warn: jest.Mock; error: jest.Mock };

const message = (headers: Record<string, unknown> = {}, routingKey = 'account.closed', body: unknown = { a: 1 }) =>
  ({
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { routingKey },
    properties: { headers, contentType: 'application/json', messageId: 'm1' },
  }) as unknown as amqplib.ConsumeMessage;

function fakeChannel(stored: Record<string, amqplib.GetMessage[]> = {}) {
  return {
    assertQueue: jest.fn().mockResolvedValue(undefined),
    sendToQueue: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    checkQueue: jest.fn(async (queue: string) => ({
      messageCount: (stored[queue] ?? []).length,
      consumerCount: queue === QUEUE ? 2 : 0,
    })),
    get: jest.fn(async (queue: string) => stored[queue]?.shift() ?? false),
  };
}
const asChannel = (channel: ReturnType<typeof fakeChannel>) => channel as unknown as amqplib.Channel;

describe('retry-policy', () => {
  beforeEach(() => jest.clearAllMocks());

  it('crea las colas de espera (con TTL que devuelve a la cola principal) y la DLQ', async () => {
    const channel = fakeChannel();

    await assertRetryQueues(asChannel(channel), QUEUE);

    expect(channel.assertQueue).toHaveBeenCalledWith(`${QUEUE}.retry`, {
      durable: true,
      arguments: expect.objectContaining({
        'x-message-ttl': expect.any(Number),
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': QUEUE,
      }),
    });
    expect(channel.assertQueue).toHaveBeenCalledWith(`${QUEUE}.dlq`, { durable: true });
  });

  it('el routing key original es el del encabezado si el mensaje ya fue reintentado', () => {
    expect(originalRoutingKey(message({}, 'account.closed'))).toBe('account.closed');
    expect(originalRoutingKey(message({ 'x-original-routing-key': 'fraud.alert' }, ''))).toBe('fraud.alert');
  });

  describe('después de un fallo (handleFailure)', () => {
    it('el primer fallo va a la cola de espera con el contador, el motivo y el routing key original, y confirma el original', () => {
      const channel = fakeChannel();
      const msg = message({}, 'account.closed');

      handleFailure(asChannel(channel), QUEUE, msg, new Error('base caída'), logger);

      const [target, content, options] = channel.sendToQueue.mock.calls[0];
      expect(target).toBe(`${QUEUE}.retry`);
      expect(content).toBe(msg.content);
      expect(options).toMatchObject({
        persistent: true,
        headers: { 'x-retry-count': 1, 'x-original-routing-key': 'account.closed', 'x-last-error': 'base caída' },
      });
      expect(channel.ack).toHaveBeenCalledWith(msg);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('el contador sigue creciendo en cada reintento y el motivo se recorta a 500 caracteres', () => {
      const channel = fakeChannel();

      handleFailure(asChannel(channel), QUEUE, message({ 'x-retry-count': 3 }), new Error('x'.repeat(900)), logger);

      const [target, , options] = channel.sendToQueue.mock.calls[0];
      expect(target).toBe(`${QUEUE}.retry`);
      expect(options.headers['x-retry-count']).toBe(4);
      expect(options.headers['x-last-error']).toHaveLength(500);
    });

    it('al agotar los intentos va a la DLQ y se registra como error', () => {
      const channel = fakeChannel();

      handleFailure(asChannel(channel), QUEUE, message({ 'x-retry-count': 5 }), new Error('sigue fallando'), logger);

      expect(channel.sendToQueue.mock.calls[0][0]).toBe(`${QUEUE}.dlq`);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('enviado a servicio.eventos.dlq'));
    });

    it('un mensaje imposible de procesar (basura) va directo a la DLQ, sin reintentos', () => {
      const channel = fakeChannel();

      handleFailure(asChannel(channel), QUEUE, message(), new PoisonMessageError('no es JSON'), logger);

      expect(channel.sendToQueue.mock.calls[0][0]).toBe(`${QUEUE}.dlq`);
      expect(channel.ack).toHaveBeenCalled();
    });

    it('si el canal está cerrado no confirma: RabbitMQ reentregará el original', () => {
      const channel = fakeChannel();
      channel.sendToQueue.mockImplementation(() => {
        throw new Error('canal cerrado');
      });

      expect(() => handleFailure(asChannel(channel), QUEUE, message(), new Error('x'), logger)).not.toThrow();

      expect(channel.ack).not.toHaveBeenCalled();
    });
  });
});
