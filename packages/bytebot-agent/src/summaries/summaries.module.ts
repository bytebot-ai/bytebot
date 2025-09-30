import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { SummariesService } from './summaries.service';

@Module({
  imports: [PrismaModule],
  providers: [SummariesService],
  exports: [SummariesService],
})
export class SummariesModule {}
