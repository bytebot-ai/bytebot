/**
 * Tool Executor Service
 * v2.3.0 M4: Routes tool execution between desktop and gateway tools
 *
 * This service provides a unified interface for tool execution that:
 * 1. Routes desktop tools to the workspace desktop (computer use)
 * 2. Routes gateway tools to Butler Service Gateway (web APIs)
 * 3. Enforces tool restrictions based on workflow configuration
 * 4. Handles high-risk tool gating (approval required)
 * 5. Supports gatewayToolsOnly mode for non-desktop workflows
 *
 * For Product 1 (Tasks): All desktop tools available, no gateway tools
 * For Product 2 (Workflows): Both desktop and gateway tools based on config
 */

import { Injectable, Logger } from '@nestjs/common';
import { GatewayService, GatewayToolResult, GATEWAY_TOOLS, GatewayToolName } from '../gateway/gateway.service';
import { WorkspaceService } from '../workspace/workspace.service';
import {
  MessageContentType,
  ToolResultContentBlock,
} from '@bytebot/shared';

/**
 * Tool execution context from task/workflow
 */
export interface ToolExecutionContext {
  taskId: string;
  workspaceId?: string | null;
  nodeRunId?: string | null;
  allowedTools: string[];
  gatewayToolsOnly: boolean;
  highRiskTools: string[];
  desktopUrl?: string;
}

/**
 * Tool execution request
 */
export interface ToolExecutionRequest {
  toolId: string;
  toolName: string;
  toolInput: Record<string, any>;
}

/**
 * Tool execution result
 */
export interface ToolExecutionResult {
  toolResultBlock: ToolResultContentBlock;
  requiresApproval: boolean;
  approvalRequestId?: string;
  isHighRisk: boolean;
  executionTimeMs: number;
}

/**
 * Desktop tool names (computer use)
 */
const DESKTOP_TOOLS = [
  'computer',
  'click',
  'type',
  'key',
  'scroll',
  'screenshot',
  'move',
  'drag',
  'cursor_position',
] as const;

type DesktopToolName = (typeof DESKTOP_TOOLS)[number];

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    private readonly gatewayService: GatewayService,
    private readonly workspaceService: WorkspaceService,
  ) {
    this.logger.log('ToolExecutorService initialized');
  }

  /**
   * Check if a tool is a desktop tool
   */
  isDesktopTool(toolName: string): boolean {
    return DESKTOP_TOOLS.includes(toolName as DesktopToolName);
  }

  /**
   * Check if a tool is a gateway tool
   */
  isGatewayTool(toolName: string): boolean {
    return this.gatewayService.isGatewayTool(toolName);
  }

  /**
   * Check if a tool is allowed in the given context
   */
  isToolAllowed(toolName: string, context: ToolExecutionContext): boolean {
    // If gatewayToolsOnly, only allow gateway tools
    if (context.gatewayToolsOnly) {
      return this.isGatewayTool(toolName);
    }

    // If no allowed tools specified, allow all tools
    if (!context.allowedTools || context.allowedTools.length === 0) {
      return true;
    }

    // Check if tool is in allowed list
    // Also allow desktop tools if not explicitly restricted
    if (this.isDesktopTool(toolName)) {
      return context.allowedTools.includes('computer') || context.allowedTools.includes(toolName);
    }

    return context.allowedTools.includes(toolName);
  }

  /**
   * Check if a tool requires approval
   */
  isHighRiskTool(toolName: string, context: ToolExecutionContext): boolean {
    // Check gateway service for default high-risk status
    if (this.gatewayService.isHighRiskTool(toolName)) {
      return true;
    }

    // Check workflow-specific high-risk list
    if (context.highRiskTools && context.highRiskTools.length > 0) {
      return context.highRiskTools.includes(toolName);
    }

    return false;
  }

  /**
   * Get available tools for a context
   */
  getAvailableTools(context: ToolExecutionContext): {
    desktop: string[];
    gateway: typeof GATEWAY_TOOLS[GatewayToolName][];
  } {
    let desktopTools: string[] = [];
    let gatewayTools = this.gatewayService.getAllTools();

    // If not gatewayToolsOnly, include desktop tools
    if (!context.gatewayToolsOnly) {
      desktopTools = [...DESKTOP_TOOLS];
    }

    // Filter by allowed list if specified
    if (context.allowedTools && context.allowedTools.length > 0) {
      desktopTools = desktopTools.filter(
        (tool) => context.allowedTools.includes(tool) || context.allowedTools.includes('computer'),
      );
      gatewayTools = gatewayTools.filter((tool) => context.allowedTools.includes(tool.name));
    }

    return { desktop: desktopTools, gateway: gatewayTools };
  }

  /**
   * Execute a gateway tool
   */
  async executeGatewayTool(
    request: ToolExecutionRequest,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const isHighRisk = this.isHighRiskTool(request.toolName, context);

    // Check if tool is allowed
    if (!this.isToolAllowed(request.toolName, context)) {
      return {
        toolResultBlock: {
          type: MessageContentType.ToolResult,
          tool_use_id: request.toolId,
          is_error: true,
          content: [
            {
              type: MessageContentType.Text,
              text: `Tool "${request.toolName}" is not allowed in this workflow context`,
            },
          ],
        },
        requiresApproval: false,
        isHighRisk,
        executionTimeMs: Date.now() - startTime,
      };
    }

    // Execute via gateway service
    const result = await this.gatewayService.executeTool({
      toolName: request.toolName,
      parameters: request.toolInput,
      taskId: context.taskId,
      nodeRunId: context.nodeRunId || undefined,
      workspaceId: context.workspaceId || undefined,
    });

    // Handle approval-required response
    if (result.requiresApproval) {
      return {
        toolResultBlock: {
          type: MessageContentType.ToolResult,
          tool_use_id: request.toolId,
          is_error: false, // Not an error, just waiting for approval
          content: [
            {
              type: MessageContentType.Text,
              text: `Action requires human approval. Approval request ID: ${result.approvalRequestId}. Please wait for approval before proceeding.`,
            },
          ],
        },
        requiresApproval: true,
        approvalRequestId: result.approvalRequestId,
        isHighRisk: true,
        executionTimeMs: result.executionTimeMs,
      };
    }

    // Return tool result
    return {
      toolResultBlock: {
        type: MessageContentType.ToolResult,
        tool_use_id: request.toolId,
        is_error: !result.success,
        content: [
          {
            type: MessageContentType.Text,
            text: result.success
              ? JSON.stringify(result.result, null, 2)
              : `Error: ${result.error}`,
          },
        ],
      },
      requiresApproval: false,
      isHighRisk,
      executionTimeMs: result.executionTimeMs,
    };
  }

  /**
   * Wait for approval and execute tool
   */
  async waitForApprovalAndExecute(
    approvalRequestId: string,
    request: ToolExecutionRequest,
    context: ToolExecutionContext,
    options: {
      pollIntervalMs?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<ToolExecutionResult> {
    const { pollIntervalMs = 5000, timeoutMs = 300000 } = options; // 5 minute timeout by default
    const startTime = Date.now();

    this.logger.log(`Waiting for approval: ${approvalRequestId}`);

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.gatewayService.checkApprovalStatus(approvalRequestId);

      switch (status.status) {
        case 'approved':
          this.logger.log(`Approval granted for ${approvalRequestId}, executing tool`);
          const result = await this.gatewayService.executeApprovedTool(approvalRequestId, {
            toolName: request.toolName,
            parameters: request.toolInput,
            taskId: context.taskId,
            nodeRunId: context.nodeRunId || undefined,
            workspaceId: context.workspaceId || undefined,
          });

          return {
            toolResultBlock: {
              type: MessageContentType.ToolResult,
              tool_use_id: request.toolId,
              is_error: !result.success,
              content: [
                {
                  type: MessageContentType.Text,
                  text: result.success
                    ? JSON.stringify(result.result, null, 2)
                    : `Error: ${result.error}`,
                },
              ],
            },
            requiresApproval: false,
            isHighRisk: true,
            executionTimeMs: Date.now() - startTime,
          };

        case 'rejected':
          this.logger.log(`Approval rejected for ${approvalRequestId}: ${status.reason}`);
          return {
            toolResultBlock: {
              type: MessageContentType.ToolResult,
              tool_use_id: request.toolId,
              is_error: true,
              content: [
                {
                  type: MessageContentType.Text,
                  text: `Action was rejected by human reviewer${status.reason ? `: ${status.reason}` : ''}`,
                },
              ],
            },
            requiresApproval: false,
            isHighRisk: true,
            executionTimeMs: Date.now() - startTime,
          };

        case 'expired':
          this.logger.log(`Approval expired for ${approvalRequestId}`);
          return {
            toolResultBlock: {
              type: MessageContentType.ToolResult,
              tool_use_id: request.toolId,
              is_error: true,
              content: [
                {
                  type: MessageContentType.Text,
                  text: 'Action approval request expired. Please try again if the action is still needed.',
                },
              ],
            },
            requiresApproval: false,
            isHighRisk: true,
            executionTimeMs: Date.now() - startTime,
          };

        case 'pending':
        default:
          // Continue waiting
          await this.sleep(pollIntervalMs);
      }
    }

    // Timeout
    return {
      toolResultBlock: {
        type: MessageContentType.ToolResult,
        tool_use_id: request.toolId,
        is_error: true,
        content: [
          {
            type: MessageContentType.Text,
            text: `Timeout waiting for approval after ${timeoutMs / 1000} seconds`,
          },
        ],
      },
      requiresApproval: false,
      isHighRisk: true,
      executionTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Build tool execution context from task
   */
  buildContextFromTask(task: {
    id: string;
    workspaceId?: string | null;
    nodeRunId?: string | null;
    allowedTools?: string[];
    gatewayToolsOnly?: boolean;
    highRiskTools?: string[];
  }): ToolExecutionContext {
    return {
      taskId: task.id,
      workspaceId: task.workspaceId,
      nodeRunId: task.nodeRunId,
      allowedTools: task.allowedTools || [],
      gatewayToolsOnly: task.gatewayToolsOnly || false,
      highRiskTools: task.highRiskTools || [],
    };
  }

  /**
   * Helper to sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
