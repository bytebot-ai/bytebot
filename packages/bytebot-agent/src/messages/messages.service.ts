import {
  Injectable,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
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

  async findEvery(taskId: string): Promise<Message[]> {
    return this.prisma.message.findMany({
      where: {
        taskId,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  async findAll(
    taskId: string,
    options?: {
      limit?: number;
      page?: number;
    },
  ): Promise<Message[]> {
    const { limit = 10, page = 1 } = options || {};

    // Calculate offset based on page and limit
    const offset = (page - 1) * limit;

    return this.prisma.message.findMany({
      where: {
        taskId,
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: limit,
      skip: offset,
    });
  }
}
