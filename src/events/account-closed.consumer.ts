import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';
import { assertRetryQueues, handleFailure, PoisonMessageError } from '../events/retry-policy';
import { AccountClosedService } from '../savings/account-closed.service';

const RECONNECT_DELAY_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cola propia de savings para este evento (con <cola>.retry y <cola>.dlq).
const QUEUE = 'savings-service.account-closed';

/**
 * Se suscribe a 'account.closed' (account-service) para cerrar los bolsillos y
 * metas vacíos del cliente que canceló su cuenta. Si RabbitMQ no está, reintenta en
 * segundo plano; un evento que falla se reintenta (<cola>.retry) y, si sigue
 * fallando, queda en la DLQ (<cola>.dlq). Procesar dos veces es inofensivo.
 */
@Injectable()
export class AccountClosedConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('AccountClosedConsumer[savings-service]');
  private connection: amqplib.ChannelModel | null = null;
  private channel: amqplib.Channel | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;

  constructor(
    private readonly config: ConfigService,
    private readonly closures: AccountClosedService,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  private async connect() {
    if (this.destroyed) return;
    const url = this.config.get<string>('RABBITMQ_URL');
    if (!url) {
      this.logger.warn('RABBITMQ_URL no configurada. No se consumirán eventos.');
      return;
    }
    try {
      const connection = await amqplib.connect(url);
      // Sin listener de 'error', un fallo de la conexión tumbaría el proceso.
      connection.on('error', (err) => this.logger.warn(`Error en la conexión con RabbitMQ: ${err.message}`));
      connection.on('close', () => {
        this.connection = null;
        this.channel = null;
        this.logger.warn('Conexión con RabbitMQ cerrada.');
        this.scheduleReconnect();
      });
      const channel = await connection.createChannel();
      channel.on('error', (err) => this.logger.warn(`Error en el canal de RabbitMQ: ${err.message}`));
      channel.on('close', () => {
        this.channel = null;
        if (!this.destroyed) connection.close().catch(() => undefined);
      });
      this.connection = connection;
      this.channel = channel;

      const exchange = this.config.get<string>('RABBITMQ_EXCHANGE', 'banklite.events');
      const queue = QUEUE;

      await channel.assertExchange(exchange, 'topic', { durable: true });
      await channel.assertQueue(queue, { durable: true });
      await channel.bindQueue(queue, exchange, 'account.closed');
      await assertRetryQueues(channel, queue);

      await channel.consume(queue, (msg) => this.handleMessage(channel, queue, msg), { noAck: false });

      this.logger.log(`Escuchando 'account.closed' en cola '${queue}'.`);
    } catch (err) {
      this.logger.warn(
        `No se pudo conectar a RabbitMQ (${(err as Error).message}). Reintentando en ${RECONNECT_DELAY_MS / 1000}s.`,
      );
      await this.connection?.close().catch(() => undefined);
      this.connection = null;
      this.channel = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
  }

  // Se usa el canal por el que llegó el mensaje: el ack debe ir por ese mismo canal.
  private async handleMessage(channel: amqplib.Channel, queue: string, msg: amqplib.ConsumeMessage | null) {
    if (!msg) return;
    try {
      let content: any;
      try {
        content = JSON.parse(msg.content.toString());
      } catch {
        throw new PoisonMessageError('El mensaje no es JSON válido.');
      }
      const data = content?.data;
      if (typeof data?.idUser !== 'string' || !UUID.test(data.idUser)) {
        this.logger.warn('Evento account.closed sin idUser válido, descartado.');
        channel.ack(msg);
        return;
      }
      await this.closures.handleAccountClosed(data.idUser);
      channel.ack(msg);
    } catch (err) {
      handleFailure(channel, queue, msg, err as Error, this.logger);
    }
  }

  async onModuleDestroy() {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
