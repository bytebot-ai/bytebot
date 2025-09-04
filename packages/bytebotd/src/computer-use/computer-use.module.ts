import { Module } from '@nestjs/common';
import { ComputerUseService } from './computer-use.service';
import { ComputerUseController } from './computer-use.controller';
import { NutModule } from '../nut/nut.module';

@Module({
  imports: [NutModule],
  controllers: [ComputerUseController],
  providers: [ComputerUseService],
  exports: [ComputerUseService],
})
export class ComputerUseModule {}
