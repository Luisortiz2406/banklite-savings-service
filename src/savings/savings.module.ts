import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Cdt } from './entities/cdt.entity';
import { Pocket } from './entities/pocket.entity';
import { SavingsOp } from './entities/savings-op.entity';
import { SavingsClientsService } from './savings-clients.service';
import { SavingsController } from './savings.controller';
import { SavingsService } from './savings.service';

@Module({
  imports: [ConfigModule, JwtModule.register({}), TypeOrmModule.forFeature([Pocket, Cdt, SavingsOp])],
  controllers: [SavingsController],
  providers: [SavingsService, SavingsClientsService, JwtAuthGuard],
})
export class SavingsModule {}
