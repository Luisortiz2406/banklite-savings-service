import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import { Request } from 'express';
import { parseTrustedKeys, TrustedKey } from '../../config/env.validation';

/**
 * Protege los endpoints de uso interno entre microservicios. Cada servicio que
 * llama a otro tiene SU PROPIA clave (su INTERNAL_API_KEY) y este servicio solo
 * acepta las de los servicios listados en INTERNAL_TRUSTED_KEYS
 * ("transfer:<clave>,card:<clave>"). Si se filtra la clave de un servicio, no
 * sirve para llamar a los que no confían en él.
 *
 * Sin INTERNAL_TRUSTED_KEYS se rechaza todo (falla cerrado). La comparación es
 * en tiempo constante y recorre todas las claves.
 */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  private readonly trusted: TrustedKey[];

  constructor(config: ConfigService) {
    this.trusted = parseTrustedKeys(config.get<string>('INTERNAL_TRUSTED_KEYS'));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { internalCaller?: string }>();
    const received = request.headers['x-internal-key'];
    if (!this.trusted.length || typeof received !== 'string' || !received) {
      throw new UnauthorizedException('Clave interna requerida');
    }

    const receivedBuffer = Buffer.from(received);
    let caller: string | undefined;
    for (const entry of this.trusted) {
      const expected = Buffer.from(entry.key);
      if (expected.length === receivedBuffer.length && timingSafeEqual(expected, receivedBuffer)) caller = entry.caller;
    }
    if (!caller) throw new UnauthorizedException('Clave interna inválida');
    request.internalCaller = caller;
    return true;
  }
}
