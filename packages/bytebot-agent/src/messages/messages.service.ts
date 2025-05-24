import { Injectable, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Message, Role, Prisma } from '@prisma/client';
import { MessageContentBlock } from '@bytebot/shared';
import { TasksGateway } from '../tasks/tasks.gateway';

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => TasksGateway))
    private readonly tasksGateway: TasksGateway,
  ) {}

  async create(data: {
    content: MessageContentBlock[];
    role: Role;
    taskId: string;
  }): Promise<Message> {
    const message = await this.prisma.message.create({
      data: {
        content: data.content as Prisma.InputJsonValue,
        role: data.role,
        taskId: data.taskId,
      },
    });

    this.tasksGateway.emitNewMessage(data.taskId, message);

    return message;
  }

  async findAll(taskId: string): Promise<Message[]> {
    return this.prisma.message.findMany({
      where: {
        taskId,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }
}
