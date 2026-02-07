import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Playbook } from '@prisma/client';

@Injectable()
export class PlaybooksService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<Playbook[]> {
    return this.prisma.playbook.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string): Promise<Playbook | null> {
    return this.prisma.playbook.findUnique({
      where: { id },
    });
  }

  async create(data: {
    name: string;
    description?: string;
    promptTemplate: string;
    requiredVariables: string[];
  }): Promise<Playbook> {
    return this.prisma.playbook.create({
      data,
    });
  }

  async update(
    id: string,
    data: {
      name?: string;
      description?: string;
      promptTemplate?: string;
      requiredVariables?: string[];
    },
  ): Promise<Playbook> {
    return this.prisma.playbook.update({
      where: { id },
      data,
    });
  }

  async remove(id: string): Promise<Playbook> {
    return this.prisma.playbook.delete({
      where: { id },
    });
  }
}
