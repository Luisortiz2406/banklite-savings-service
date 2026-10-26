import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InternalKeyGuard } from '../common/guards/internal-key.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ClosureSummaryService } from './closure-summary.service';
import { Cdt } from './entities/cdt.entity';
import { Pocket } from './entities/pocket.entity';
import { SavingsOp } from './entities/savings-op.entity';
import { SavingsClientsService } from './savings-clients.service';
import { SavingsCatalogController } from './savings-catalog.controller';
import { SavingsController } from './savings.controller';
import { SavingsService } from './savings.service';
import { InternalSavingsController } from './internal-savings.controller';

@Module({
  imports: [ConfigModule, JwtModule.register({}), TypeOrmModule.forFeature([Pocket, Cdt, SavingsOp])],
  controllers: [SavingsCatalogController, SavingsController, InternalSavingsController],
  providers: [SavingsService, SavingsClientsService, JwtAuthGuard, ClosureSummaryService, InternalKeyGuard],
})
export class SavingsModule {}
