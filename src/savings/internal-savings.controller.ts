import { Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { ClosureSummaryService } from './closure-summary.service';

/** Endpoints entre servicios (red interna, x-internal-key). El gateway responde 404 a /internal desde afuera. */
@Controller('internal/savings')
@UseGuards(InternalKeyGuard)
export class InternalSavingsController {
  constructor(private readonly closure: ClosureSummaryService) {}

  /** Lo que impediría cancelar la cuenta del cliente: solo account-service. */
  @Get('users/:idUser/resumen-cierre')
  resumenCierre(@Param('idUser', ParseUUIDPipe) idUser: string, @Req() request: Request) {
    if ((request as any).internalCaller !== 'account') {
      throw new ForbiddenException('Solo account-service puede pedir este resumen.');
    }
    return this.closure.summary(idUser);
  }
}
