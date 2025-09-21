import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DoubaoService } from './doubao.service';

@Module({
  imports: [ConfigModule],
  providers: [DoubaoService],
  exports: [DoubaoService],
})
export class DoubaoModule {}
