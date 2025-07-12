import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Delete,
  HttpStatus,
  HttpCode,
  UseGuards,
  Query,
  Req,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { Message, Task } from '@prisma/client';
import { GuideTaskDto } from './dto/guide-task.dto';
import { MessagesService } from '../messages/messages.service';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { Request } from 'express';
import { ANTHROPIC_MODELS } from '../anthropic/anthropic.constants';
import { OPENAI_MODELS } from '../openai/openai.constants';
import { GOOGLE_MODELS } from 'src/google/google.constants';

const authEnabled = process.env.AUTH_ENABLED === 'true';

const googleApiKey = process.env.GOOGLE_API_KEY;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const openaiApiKey = process.env.OPENAI_API_KEY;

const models = [
  ...(anthropicApiKey ? ANTHROPIC_MODELS : []),
  ...(openaiApiKey ? OPENAI_MODELS : []),
  ...(googleApiKey ? GOOGLE_MODELS : []),
];

@Controller('tasks')
@UseGuards(...(authEnabled ? [AuthGuard] : []))
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly messagesService: MessagesService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() createTaskDto: CreateTaskDto,
    @Req() req: Request,
  ): Promise<Task> {
    // Add user ID if auth is enabled and user is authenticated
    if (authEnabled && (req as any).user?.id) {
      createTaskDto.userId = (req as any).user.id;
    }
    return this.tasksService.create(createTaskDto);
  }

  @Get()
  async findAll(): Promise<Task[]> {
    return this.tasksService.findAll();
  }

  @Get('models')
  async getModels() {
    return models;
  }

  @Get(':id')
  async findById(@Param('id') id: string): Promise<Task> {
    return this.tasksService.findById(id);
  }

  @Get(':id/messages')
  async taskMessages(
    @Param('id') taskId: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ): Promise<Message[]> {
    const options = {
      limit: limit ? parseInt(limit, 10) : undefined,
      page: page ? parseInt(page, 10) : undefined,
    };

    const messages = await this.messagesService.findAll(taskId, options);
    return messages;
  }

  @Get(':id/messages/raw')
  async taskRawMessages(
    @Param('id') taskId: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ): Promise<Message[]> {
    const options = {
      limit: limit ? parseInt(limit, 10) : undefined,
      page: page ? parseInt(page, 10) : undefined,
    };

    return this.messagesService.findRawMessages(taskId, options);
  }

  @Get(':id/messages/processed')
  async taskProcessedMessages(
    @Param('id') taskId: string,
    @Query('limit') limit?: string,
    @Query('page') page?: string,
  ) {
    const options = {
      limit: limit ? parseInt(limit, 10) : undefined,
      page: page ? parseInt(page, 10) : undefined,
    };

    return this.messagesService.findProcessedMessages(taskId, options);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateTaskDto: UpdateTaskDto,
  ): Promise<Task> {
    return this.tasksService.update(id, updateTaskDto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@Param('id') id: string): Promise<void> {
    await this.tasksService.delete(id);
  }

  @Post(':id/guide')
  @HttpCode(HttpStatus.CREATED)
  async guideTask(
    @Param('id') taskId: string,
    @Body() guideTaskDto: GuideTaskDto,
  ): Promise<Task> {
    return this.tasksService.guideTask(taskId, guideTaskDto);
  }

  @Post(':id/takeover')
  @HttpCode(HttpStatus.OK)
  async takeOver(@Param('id') taskId: string): Promise<Task> {
    return this.tasksService.takeOver(taskId);
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  async resume(@Param('id') taskId: string): Promise<Task> {
    return this.tasksService.resume(taskId);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Param('id') taskId: string): Promise<Task> {
    return this.tasksService.cancel(taskId);
  }
}
