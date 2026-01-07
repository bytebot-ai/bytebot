import { Module } from '@nestjs/common';
import { PlaybooksService } from './playbooks.service';
import { PlaybooksController } from './playbooks.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [PlaybooksController],
  providers: [PlaybooksService],
  exports: [PlaybooksService],
})
export class PlaybooksModule {}
