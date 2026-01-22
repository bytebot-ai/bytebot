import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksGateway } from './tasks.gateway';
import { TitleGenerationService } from './title-generation.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MessagesModule } from '../messages/messages.module';
import { TaskControllerModule } from '../task-controller/task-controller.module';

@Module({
  imports: [PrismaModule, MessagesModule, TaskControllerModule],
  controllers: [TasksController],
  providers: [TasksService, TasksGateway, TitleGenerationService],
  exports: [TasksService, TasksGateway, TitleGenerationService],
})
export class TasksModule {}
