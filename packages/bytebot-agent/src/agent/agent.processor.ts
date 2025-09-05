import { TasksService } from '../tasks/tasks.service';
import { MessagesService } from '../messages/messages.service';
import { Injectable, Logger } from '@nestjs/common';
import {
  Message,
  Role,
  Task,
  TaskPriority,
  TaskStatus,
  TaskType,
} from '@prisma/client';
import { AnthropicService } from '../anthropic/anthropic.service';
import {
  isComputerToolUseContentBlock,
  isSetTaskStatusToolUseBlock,
  isCreateTaskToolUseBlock,
  SetTaskStatusToolUseBlock,
} from '@bytebot/shared';

import {
  MessageContentBlock,
  MessageContentType,
  ToolResultContentBlock,
  TextContentBlock,
} from '@bytebot/shared';
import { InputCaptureService } from './input-capture.service';
import { OnEvent } from '@nestjs/event-emitter';
import { OpenAIService } from '../openai/openai.service';
import { GoogleService } from '../google/google.service';
import {
  BytebotAgentModel,
  BytebotAgentService,
  BytebotAgentResponse,
} from './agent.types';
import {
  AGENT_SYSTEM_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
} from './agent.constants';
import { SummariesService } from '../summaries/summaries.service';
import { handleComputerToolUse } from './agent.computer-use';
import { ProxyService } from '../proxy/proxy.service';
import { PlannerService } from './planner.service';
import { ReflectorService } from './reflector.service';

@Injectable()
export class AgentProcessor {
  private readonly logger = new Logger(AgentProcessor.name);
  private currentTaskId: string | null = null;
  private isProcessing = false;
  private abortController: AbortController | null = null;
  private services: Record<string, BytebotAgentService> = {};

  constructor(
    private readonly tasksService: TasksService,
    private readonly messagesService: MessagesService,
    private readonly summariesService: SummariesService,
    private readonly anthropicService: AnthropicService,
    private readonly openaiService: OpenAIService,
    private readonly googleService: GoogleService,
    private readonly proxyService: ProxyService,
    private readonly inputCaptureService: InputCaptureService,
    private readonly plannerService: PlannerService,
    private readonly reflectorService: ReflectorService,
  ) {
    this.services = {
      anthropic: this.anthropicService,
      openai: this.openaiService,
      google: this.googleService,
      proxy: this.proxyService,
    };
    this.logger.log('AgentProcessor initialized');
  }

  /**
   * Check if the processor is currently processing a task
   */
  isRunning(): boolean {
    return this.isProcessing;
  }

  /**
   * Get the current task ID being processed
   */
  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  @OnEvent('task.takeover')
  handleTaskTakeover({ taskId }: { taskId: string }) {
    this.logger.log(`Task takeover event received for task ID: ${taskId}`);

    // If the agent is still processing this task, abort any in-flight operations
    if (this.currentTaskId === taskId && this.isProcessing) {
      this.abortController?.abort();
    }

    // Always start capturing user input so that emitted actions are received
    this.inputCaptureService.start(taskId);
  }

  @OnEvent('task.resume')
  handleTaskResume({ taskId }: { taskId: string }) {
    if (this.currentTaskId === taskId && this.isProcessing) {
      this.logger.log(`Task resume event received for task ID: ${taskId}`);
      this.abortController = new AbortController();

      void this.runIteration(taskId);
    }
  }

  @OnEvent('task.cancel')
  async handleTaskCancel({ taskId }: { taskId: string }) {
    this.logger.log(`Task cancel event received for task ID: ${taskId}`);

    await this.stopProcessing();
  }

  async processTask(taskId: string) {
    this.logger.log(`Starting processing for task ID: ${taskId}`);

    if (this.isProcessing) {
      this.logger.warn('AgentProcessor is already processing another task');
      return;
    }

    this.isProcessing = true;
    this.currentTaskId = taskId;
    this.abortController = new AbortController();

    const task = await this.tasksService.findById(taskId);

    // Only generate a plan if one doesn't already exist
    if (!task.plan) {
      this.logger.log(`No plan found for task ${taskId}. Generating one...`);
      const messages = await this.messagesService.findEvery(taskId);
      const initialMessage = messages.find((m) => m.role === Role.USER);

      if (initialMessage) {
        const generatedPlan = await this.plannerService.generatePlan(
          task,
          initialMessage,
        );
        await this.tasksService.update(taskId, {
          plan: generatedPlan as any,
        });
        this.logger.log(`Plan generated and saved for task ${taskId}.`);
      } else {
        this.logger.warn(
          `Could not find an initial message for task ${taskId} to generate a plan.`,
        );
      }
    }

    // Kick off the first iteration without blocking the caller
    void this.runIteration(taskId);
  }

  /**
   * Runs a single iteration of task processing and schedules the next
   * iteration via setImmediate while the task remains RUNNING.
   */
  private async runIteration(taskId: string): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    try {
      // Use findById to ensure we get the latest task state, including the plan
      const task = await this.tasksService.findById(taskId);

      if (task.status !== TaskStatus.RUNNING) {
        this.logger.log(
          `Task processing completed for task ID: ${taskId} with status: ${task.status}`,
        );
        this.isProcessing = false;
        this.currentTaskId = null;
        return;
      }

      this.logger.log(`Processing iteration for task ID: ${taskId}`);
      this.abortController = new AbortController();

      const plan = (task.plan as string[]) || [];
      const planStep = task.planStep;

      // If there's a plan, use the plan-driven logic
      if (plan && plan.length > 0) {
        // Check if the plan is complete
        if (planStep >= plan.length) {
          this.logger.log(`Plan complete for task ${taskId}. Marking as completed.`);
          await this.tasksService.update(taskId, {
            status: TaskStatus.COMPLETED,
            completedAt: new Date(),
          });
          this.stopProcessing();
          return;
        }

        const messages = await this._getPlanDrivenLLMContext(task);
        const agentResponse = await this._callLLM(task, messages);

        await this.messagesService.create({
          content: agentResponse.contentBlocks,
          role: Role.ASSISTANT,
          taskId,
        });

        const { generatedToolResults, setTaskStatusToolUseBlock } =
          await this._executeTools(task, agentResponse.contentBlocks);

        if (generatedToolResults.length > 0) {
          await this.messagesService.create({
            content: generatedToolResults,
            role: Role.USER,
            taskId,
          });
        }

        const reflectionContext = [
          ...messages,
          {
            role: Role.ASSISTANT,
            content: agentResponse.contentBlocks,
          } as Message,
          {
            role: Role.USER,
            content: generatedToolResults,
          } as Message,
        ];

        const reflection = await this.reflectorService.reflectOnOutcome(
          task,
          reflectionContext,
        );

        await this.messagesService.create({
          content: [
            {
              type: MessageContentType.Text,
              text: `Reflection: ${reflection.status} - ${reflection.reason}`,
            },
          ],
          role: Role.ASSISTANT,
          taskId,
        });

        switch (reflection.status) {
          case 'success':
            this.logger.log(
              `Step ${planStep + 1} of plan for task ${taskId} was successful. Advancing to next step.`,
            );
            await this.tasksService.update(taskId, {
              planStep: planStep + 1,
            });
            break;
          case 'failure':
            this.logger.warn(
              `Step ${planStep + 1} of plan for task ${taskId} failed. Reason: ${reflection.reason}. Marking task as needs help.`,
            );
            await this.tasksService.update(taskId, {
              status: TaskStatus.NEEDS_HELP,
            });
            break;
          case 'retry':
            this.logger.log(
              `Step ${planStep + 1} of plan for task ${taskId} needs a retry. Reason: ${reflection.reason}. Retrying step.`,
            );
            // Do nothing, the loop will repeat the same step with the new reflection context.
            break;
        }

        if (setTaskStatusToolUseBlock) {
          await this._updateTaskState(taskId, setTaskStatusToolUseBlock);
        }
      } else {
        // Fallback to old logic if there's no plan
        this.logger.warn(`No plan found for task ${taskId}. Running in reactive mode.`);
        const messages = await this._getLLMContext(taskId);
        const agentResponse = await this._callLLM(task, messages);

        if (agentResponse.contentBlocks.length === 0) {
          this.logger.warn(`Task ID: ${taskId} received no content blocks from LLM, marking as failed`);
          await this.tasksService.update(taskId, { status: TaskStatus.FAILED });
          this.stopProcessing();
          return;
        }

        await this.messagesService.create({
          content: agentResponse.contentBlocks,
          role: Role.ASSISTANT,
          taskId,
        });

        await this._handleSummarization(task, messages, agentResponse);

        const { generatedToolResults, setTaskStatusToolUseBlock } =
          await this._executeTools(task, agentResponse.contentBlocks);

        if (generatedToolResults.length > 0) {
          await this.messagesService.create({
            content: generatedToolResults,
            role: Role.USER,
            taskId,
          });
        }

        if (setTaskStatusToolUseBlock) {
          await this._updateTaskState(taskId, setTaskStatusToolUseBlock);
        }
      }

      // Schedule the next iteration without blocking
      if (this.isProcessing) {
        setImmediate(() => this.runIteration(taskId));
      }
    } catch (error: any) {
      if (error?.name === 'BytebotAgentInterrupt') {
        this.logger.warn(`Processing aborted for task ID: ${taskId}`);
      } else {
        this.logger.error(
          `Error during task processing iteration for task ID: ${taskId} - ${error.message}`,
          error.stack,
        );
        await this.tasksService.update(taskId, {
          status: TaskStatus.FAILED,
        });
        this.isProcessing = false;
        this.currentTaskId = null;
      }
    }
  }

  private async _getLLMContext(taskId: string): Promise<Message[]> {
    const latestSummary = await this.summariesService.findLatest(taskId);
    const unsummarizedMessages =
      await this.messagesService.findUnsummarized(taskId);
    const messages = [
      ...(latestSummary
        ? [
            ({
              id: '',
              createdAt: new Date(),
              updatedAt: new Date(),
              taskId,
              summaryId: null,
              userId: null,
              role: Role.USER,
              content: [
                {
                  type: MessageContentType.Text,
                  text: latestSummary.content,
                },
              ],
            } as unknown) as Message,
          ]
        : []),
      ...unsummarizedMessages,
    ];
    this.logger.debug(
      `Sending ${messages.length} messages to LLM for processing`,
    );
    return messages;
  }

  private async _getPlanDrivenLLMContext(task: Task): Promise<Message[]> {
    const plan = (task.plan as string[]) || [];
    const planStep = task.planStep;
    const currentStep = plan[planStep];

    const planContext = `
The overall goal is: "${task.description}"

Here is the plan:
${plan.map((step, index) => `${index + 1}. ${step}`).join('\n')}

You are currently on step ${planStep + 1}: "${currentStep}"
Please perform the action(s) required to complete this step. Focus only on this step.
`;

    const unsummarizedMessages = await this.messagesService.findUnsummarized(
      task.id,
    );

    const messages = [
      {
        id: '',
        createdAt: new Date(),
        updatedAt: new Date(),
        taskId: task.id,
        summaryId: null,
        userId: null,
        role: Role.USER,
        content: [
          {
            type: MessageContentType.Text,
            text: planContext,
          },
        ],
      } as unknown as Message,
      ...unsummarizedMessages.slice(-10), // Take the last 10 messages to keep context short
    ];

    return messages;
  }

  private async _callLLM(
    task: Task,
    messages: Message[],
  ): Promise<BytebotAgentResponse> {
    const model = task.model as unknown as BytebotAgentModel;
    const service = this.services[model.provider];
    if (!service) {
      this.logger.warn(
        `No service found for model provider: ${model.provider}`,
      );
      await this.tasksService.update(task.id, {
        status: TaskStatus.FAILED,
      });
      this.isProcessing = false;
      this.currentTaskId = null;
      throw new Error(`No service for provider ${model.provider}`);
    }

    return service.generateMessage(
      AGENT_SYSTEM_PROMPT,
      messages,
      model.name,
      true,
      this.abortController.signal,
    );
  }

  private async _executeTools(
    task: Task,
    messageContentBlocks: MessageContentBlock[],
  ): Promise<{
    generatedToolResults: ToolResultContentBlock[];
    setTaskStatusToolUseBlock: SetTaskStatusToolUseBlock | null;
  }> {
    const generatedToolResults: ToolResultContentBlock[] = [];
    let setTaskStatusToolUseBlock: SetTaskStatusToolUseBlock | null = null;

    for (const block of messageContentBlocks) {
      if (isComputerToolUseContentBlock(block)) {
        const result = await handleComputerToolUse(block, this.logger);
        generatedToolResults.push(result);
      }

      if (isCreateTaskToolUseBlock(block)) {
        const type = block.input.type?.toUpperCase() as TaskType;
        const priority = block.input.priority?.toUpperCase() as TaskPriority;

        await this.tasksService.create({
          description: block.input.description,
          type,
          createdBy: Role.ASSISTANT,
          ...(block.input.scheduledFor && {
            scheduledFor: new Date(block.input.scheduledFor),
          }),
          model: task.model,
          priority,
        });

        generatedToolResults.push({
          type: MessageContentType.ToolResult,
          tool_use_id: block.id,
          content: [
            {
              type: MessageContentType.Text,
              text: 'The task has been created',
            },
          ],
        });
      }

      if (isSetTaskStatusToolUseBlock(block)) {
        setTaskStatusToolUseBlock = block;

        generatedToolResults.push({
          type: MessageContentType.ToolResult,
          tool_use_id: block.id,
          is_error: block.input.status === 'failed',
          content: [
            {
              type: MessageContentType.Text,
              text: block.input.description,
            },
          ],
        });
      }
    }

    return { generatedToolResults, setTaskStatusToolUseBlock };
  }

  private async _updateTaskState(
    taskId: string,
    setTaskStatusToolUseBlock: SetTaskStatusToolUseBlock,
  ) {
    switch (setTaskStatusToolUseBlock.input.status) {
      case 'completed':
        await this.tasksService.update(taskId, {
          status: TaskStatus.COMPLETED,
          completedAt: new Date(),
        });
        break;
      case 'needs_help':
        await this.tasksService.update(taskId, {
          status: TaskStatus.NEEDS_HELP,
        });
        break;
    }
  }

  private async _handleSummarization(
    task: Task,
    messages: Message[],
    agentResponse: BytebotAgentResponse,
  ) {
    const model = task.model as unknown as BytebotAgentModel;
    const service = this.services[model.provider];
    const contextWindow = model.contextWindow || 200000;
    const contextThreshold = contextWindow * 0.75;
    const shouldSummarize =
      agentResponse.tokenUsage.totalTokens >= contextThreshold;

    if (shouldSummarize) {
      try {
        const summaryResponse = await service.generateMessage(
          SUMMARIZATION_SYSTEM_PROMPT,
          [
            ...messages,
            {
              id: '',
              createdAt: new Date(),
              updatedAt: new Date(),
              taskId: task.id,
              summaryId: null,
              userId: null,
              role: Role.USER,
              content: [
                {
                  type: MessageContentType.Text,
                  text: 'Respond with a summary of the messages above. Do not include any additional information.',
                },
              ],
            },
          ],
          model.name,
          false,
          this.abortController.signal,
        );

        const summaryContentBlocks = summaryResponse.contentBlocks;
        const summaryContent = summaryContentBlocks
          .filter(
            (block: MessageContentBlock) =>
              block.type === MessageContentType.Text,
          )
          .map((block: TextContentBlock) => block.text)
          .join('\n');

        const summary = await this.summariesService.create({
          content: summaryContent,
          taskId: task.id,
        });

        await this.messagesService.attachSummary(task.id, summary.id, [
          ...messages.map((message) => message.id),
        ]);

        this.logger.log(
          `Generated summary for task ${task.id} due to token usage (${agentResponse.tokenUsage.totalTokens}/${contextWindow})`,
        );
      } catch (error: any) {
        this.logger.error(
          `Error summarizing messages for task ID: ${task.id}`,
          error.stack,
        );
      }
    }

    this.logger.debug(
      `Token usage for task ${task.id}: ${agentResponse.tokenUsage.totalTokens}/${contextWindow} (${Math.round((agentResponse.tokenUsage.totalTokens / contextWindow) * 100)}%)`,
    );
  }

  async stopProcessing(): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    this.logger.log(`Stopping execution of task ${this.currentTaskId}`);

    // Signal any in-flight async operations to abort
    this.abortController?.abort();

    await this.inputCaptureService.stop();

    this.isProcessing = false;
    this.currentTaskId = null;
  }
}
