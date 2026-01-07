import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Put,
  NotFoundException,
} from '@nestjs/common';
import { PlaybooksService } from './playbooks.service';
import { Playbook } from '@prisma/client';

@Controller('playbooks')
export class PlaybooksController {
  constructor(private readonly playbooksService: PlaybooksService) {}

  @Get()
  findAll(): Promise<Playbook[]> {
    return this.playbooksService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<Playbook> {
    const playbook = await this.playbooksService.findOne(id);
    if (!playbook) {
      throw new NotFoundException(`Playbook with ID ${id} not found`);
    }
    return playbook;
  }

  @Post()
  create(
    @Body()
    createPlaybookDto: {
      name: string;
      description?: string;
      promptTemplate: string;
      requiredVariables: string[];
    },
  ): Promise<Playbook> {
    return this.playbooksService.create(createPlaybookDto);
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body()
    updatePlaybookDto: {
      name?: string;
      description?: string;
      promptTemplate?: string;
      requiredVariables?: string[];
    },
  ): Promise<Playbook> {
    return this.playbooksService.update(id, updatePlaybookDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string): Promise<Playbook> {
    return this.playbooksService.remove(id);
  }
}
