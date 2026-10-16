import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnv } from './config/env.validation';
import { HealthController } from './health.controller';
import { Cdt } from './savings/entities/cdt.entity';
import { Pocket } from './savings/entities/pocket.entity';
import { SavingsOp } from './savings/entities/savings-op.entity';
import { SavingsModule } from './savings/savings.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv(
        [
          { key: 'JWT_SECRET', type: 'secret' },
          { key: 'INTERNAL_API_KEY', type: 'secret' },
          { key: 'DATABASE_URL', type: 'url' },
        ],
        ['JWT_SECRET', 'INTERNAL_API_KEY'],
      ),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('DATABASE_URL'),
        entities: [Pocket, Cdt, SavingsOp],
        synchronize: true,
        logging: false,
      }),
    }),
    SavingsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
