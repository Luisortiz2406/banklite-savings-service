import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SavingsService } from './savings.service';

class CreatePocketDto {
  @IsIn(['pocket', 'goal'])
  kind: 'pocket' | 'goal';

  @IsString()
  @MaxLength(40)
  name: string;

  @Matches(/^[a-z]{2,20}$/)
  icon: string;

  // Solo metas.
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 0 })
  @Max(999_999_999_999)
  target?: number;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha debe tener el formato AAAA-MM-DD.' })
  targetDate?: string;
}

class MoveDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999_999_999_999)
  amount: number;

  @IsUUID()
  idempotencyKey: string;
}

class KeyDto {
  @IsUUID()
  idempotencyKey: string;
}

class OpenCdtDto {
  @IsInt()
  @Min(1)
  @Max(999_999_999_999)
  amount: number;

  @IsInt()
  days: number;

  @IsUUID()
  idempotencyKey: string;
}

const userOf = (request: Request): string => (request as any).user.idUser;
const tokenOf = (request: Request): string => (request as any).accessToken;

/** Bolsillos, metas de ahorro y CDT del cliente. */
@Controller('savings')
@UseGuards(JwtAuthGuard)
export class SavingsController {
  constructor(private readonly savings: SavingsService) {}

  @Get()
  summary(@Req() request: Request) {
    return this.savings.summary(userOf(request));
  }

  @Post('pockets')
  createPocket(@Body() dto: CreatePocketDto, @Req() request: Request) {
    return this.savings.createPocket(userOf(request), tokenOf(request), dto);
  }

  @Post('pockets/:id/deposit')
  @HttpCode(HttpStatus.OK)
  deposit(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveDto, @Req() request: Request) {
    return this.savings.deposit(userOf(request), id, dto.amount, dto.idempotencyKey);
  }

  @Post('pockets/:id/withdraw')
  @HttpCode(HttpStatus.OK)
  withdraw(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveDto, @Req() request: Request) {
    return this.savings.withdraw(userOf(request), id, dto.amount, dto.idempotencyKey);
  }

  /** Saca todo lo que tenga y lo cierra (eliminar bolsillo, cerrar meta). */
  @Post('pockets/:id/close')
  @HttpCode(HttpStatus.OK)
  close(@Param('id', ParseUUIDPipe) id: string, @Body() dto: KeyDto, @Req() request: Request) {
    return this.savings.withdraw(userOf(request), id, null, dto.idempotencyKey, true);
  }

  @Post('cdts')
  openCdt(@Body() dto: OpenCdtDto, @Req() request: Request) {
    return this.savings.openCdt(userOf(request), tokenOf(request), dto.amount, dto.days, dto.idempotencyKey);
  }

  @Post('cdts/:id/collect')
  @HttpCode(HttpStatus.OK)
  collect(@Param('id', ParseUUIDPipe) id: string, @Body() dto: KeyDto, @Req() request: Request) {
    return this.savings.collectCdt(userOf(request), id, dto.idempotencyKey);
  }

  @Post('cdts/:id/demo-mature')
  @HttpCode(HttpStatus.OK)
  demoMature(@Param('id', ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.savings.demoMature(userOf(request), id);
  }
}
