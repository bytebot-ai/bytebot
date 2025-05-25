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
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { Message, Task } from '@prisma/client';
import { GuideTaskDto } from './dto/guide-task.dto';
import { MessagesService } from 'src/messages/messages.service';

@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasksService: TasksService,
    private readonly messagesService: MessagesService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() createTaskDto: CreateTaskDto): Promise<Task> {
    return this.tasksService.create(createTaskDto);
  }

  @Get()
  async findAll(): Promise<Task[]> {
    return this.tasksService.findAll();
  }

  @Get(':id')
  async findById(@Param('id') id: string): Promise<Task> {
    return this.tasksService.findById(id);
  }

  @Get(':id/messages')
  async taskMessages(@Param('id') taskId: string): Promise<Message[]> {
    const messages = await this.messagesService.findAll(taskId);
    return messages;
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
  async resumeControl(@Param('id') taskId: string): Promise<Task> {
    return this.tasksService.resumeControl(taskId);
  }
}
