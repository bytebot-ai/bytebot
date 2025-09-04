import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Summary } from '@prisma/client';

@Injectable()
export class SummariesService {
  constructor(private prisma: PrismaService) {}

  async create(data: {
    taskId: string;
    content: string;
    parentId?: string;
  }): Promise<Summary> {
    return this.prisma.summary.create({
      data: {
        taskId: data.taskId,
        content: data.content,
        ...(data.parentId ? { parentId: data.parentId } : {}),
      },
    });
  }

  async findLatest(taskId: string): Promise<Summary | null> {
    return this.prisma.summary.findFirst({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findAll(taskId: string): Promise<Summary[]> {
    return this.prisma.summary.findMany({
      where: { taskId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
