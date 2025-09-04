import { Module, forwardRef } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { PrismaModule } from '../prisma/prisma.module';
import { TasksModule } from '../tasks/tasks.module';

@Module({
  imports: [PrismaModule, forwardRef(() => TasksModule)],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
