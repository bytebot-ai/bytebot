import { Module } from '@nestjs/common';
import { NutService } from './nut.service';

@Module({
  providers: [NutService],
  exports: [NutService],
})
export class NutModule {}
