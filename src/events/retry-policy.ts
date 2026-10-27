import type { Logger } from '@nestjs/common';
import type * as amqplib from 'amqplib';

const MAX_RETRIES = Number(process.env.EVENT_MAX_RETRIES ?? 5);
const RETRY_DELAY_MS = Number(process.env.EVENT_RETRY_DELAY_MS ?? 10_000);

const RETRY_COUNT_HEADER = 'x-retry-count';
const ORIGINAL_KEY_HEADER = 'x-original-routing-key';

/** Mensaje que nunca se podrá procesar (p. ej. JSON corrupto): va directo a la DLQ. */
export class PoisonMessageError extends Error {}

/**
 * Colas auxiliares de una cola de consumo:
 * - <cola>.retry: retiene el mensaje RETRY_DELAY_MS y lo devuelve a <cola>
 *   (TTL + dead-letter al exchange por defecto).
 * - <cola>.dlq: mensajes que agotaron los reintentos, para revisión manual.
 * La cola principal no cambia de argumentos, así que funciona con colas ya creadas.
 */
export async function assertRetryQueues(channel: amqplib.Channel, queue: string) {
  await channel.assertQueue(`${queue}.retry`, {
    durable: true,
    arguments: {
      'x-message-ttl': RETRY_DELAY_MS,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': queue,
    },
  });
  await channel.assertQueue(`${queue}.dlq`, { durable: true });
}

/** Routing key con la que se publicó el evento, también en los mensajes reintentados. */
export function originalRoutingKey(msg: amqplib.ConsumeMessage): string {
  return (msg.properties.headers?.[ORIGINAL_KEY_HEADER] as string | undefined) ?? msg.fields.routingKey;
}

/**
 * Tras un fallo: reintenta más tarde o, si se agotaron los intentos (o el
 * mensaje es irrecuperable), lo manda a la DLQ. En ambos casos confirma el
 * original para que no bloquee la cola.
 */
export function handleFailure(
  channel: amqplib.Channel,
  queue: string,
  msg: amqplib.ConsumeMessage,
  error: Error,
  logger: Logger,
) {
  const attempt = Number(msg.properties.headers?.[RETRY_COUNT_HEADER] ?? 0) + 1;
  const poison = error instanceof PoisonMessageError;
  const target = poison || attempt > MAX_RETRIES ? `${queue}.dlq` : `${queue}.retry`;

  const headers = {
    ...msg.properties.headers,
    [RETRY_COUNT_HEADER]: attempt,
    [ORIGINAL_KEY_HEADER]: originalRoutingKey(msg),
    'x-last-error': error.message.slice(0, 500),
  };

  try {
    channel.sendToQueue(target, msg.content, {
      persistent: true,
      contentType: msg.properties.contentType,
      messageId: msg.properties.messageId,
      headers,
    });
    channel.ack(msg);
  } catch {
    // Canal cerrado: RabbitMQ reentregará el mensaje original al reconectar.
    return;
  }

  if (target.endsWith('.dlq')) {
    logger.error(
      `Evento '${originalRoutingKey(msg)}' enviado a ${target} tras ${attempt} intento(s): ${error.message}`,
    );
  } else {
    logger.warn(
      `Evento '${originalRoutingKey(msg)}' falló (intento ${attempt}/${MAX_RETRIES}); se reintenta en ${RETRY_DELAY_MS / 1000}s: ${error.message}`,
    );
  }
}
