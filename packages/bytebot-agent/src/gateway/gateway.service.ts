/**
 * Butler Service Gateway Client
 * v2.3.0 M4: Integrates with Butler Service Gateway for non-desktop tools
 *
 * The Butler Service Gateway provides 25+ pre-integrated tools via unified REST API:
 * - search_web_search: Web search
 * - weather_get_current: Weather data
 * - communications_send_email: Email (high-risk, requires approval)
 * - communications_send_sms: SMS (high-risk, requires approval)
 * - calendar_create_event: Calendar management
 * - notes_create: Note taking
 * - And more...
 *
 * For Product 2 Workflows, the agent can use these gateway tools without
 * needing desktop access, allowing parallel execution across nodes.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Gateway tool execution request
 */
export interface GatewayToolRequest {
  toolName: string;
  parameters: Record<string, any>;
  taskId?: string;
  nodeRunId?: string;
  workspaceId?: string;
}

/**
 * Gateway tool execution result
 */
export interface GatewayToolResult {
  success: boolean;
  result?: any;
  error?: string;
  executionTimeMs: number;
  requiresApproval?: boolean;
  approvalRequestId?: string;
}

/**
 * Gateway tool definition interface (mutable version for filtering)
 */
export interface GatewayToolDefinition {
  name: string;
  description: string;
  category: string;
  highRisk: boolean;
}

/**
 * Available gateway tools (from Butler Service Gateway)
 */
export const GATEWAY_TOOLS = {
  // Search tools
  search_web_search: {
    name: 'search_web_search',
    description: 'Search the web for information',
    category: 'search',
    highRisk: false,
  },
  search_news: {
    name: 'search_news',
    description: 'Search for news articles',
    category: 'search',
    highRisk: false,
  },

  // Weather tools
  weather_get_current: {
    name: 'weather_get_current',
    description: 'Get current weather for a location',
    category: 'weather',
    highRisk: false,
  },
  weather_get_forecast: {
    name: 'weather_get_forecast',
    description: 'Get weather forecast for a location',
    category: 'weather',
    highRisk: false,
  },

  // Communication tools (HIGH RISK - require approval)
  communications_send_email: {
    name: 'communications_send_email',
    description: 'Send an email to a recipient',
    category: 'communications',
    highRisk: true,
  },
  communications_send_sms: {
    name: 'communications_send_sms',
    description: 'Send an SMS message',
    category: 'communications',
    highRisk: true,
  },

  // Calendar tools
  calendar_list_events: {
    name: 'calendar_list_events',
    description: 'List calendar events',
    category: 'calendar',
    highRisk: false,
  },
  calendar_create_event: {
    name: 'calendar_create_event',
    description: 'Create a calendar event',
    category: 'calendar',
    highRisk: false,
  },
  calendar_delete_event: {
    name: 'calendar_delete_event',
    description: 'Delete a calendar event',
    category: 'calendar',
    highRisk: true,
  },

  // Notes tools
  notes_create: {
    name: 'notes_create',
    description: 'Create a new note',
    category: 'notes',
    highRisk: false,
  },
  notes_list: {
    name: 'notes_list',
    description: 'List notes',
    category: 'notes',
    highRisk: false,
  },
  notes_delete: {
    name: 'notes_delete',
    description: 'Delete a note',
    category: 'notes',
    highRisk: true,
  },

  // Document tools
  document_parse: {
    name: 'document_parse',
    description: 'Parse and extract content from a document',
    category: 'document',
    highRisk: false,
  },
  document_summarize: {
    name: 'document_summarize',
    description: 'Summarize a document',
    category: 'document',
    highRisk: false,
  },

  // Data tools
  data_extract: {
    name: 'data_extract',
    description: 'Extract structured data from text',
    category: 'data',
    highRisk: false,
  },
  data_transform: {
    name: 'data_transform',
    description: 'Transform data between formats',
    category: 'data',
    highRisk: false,
  },

  // File tools
  file_read: {
    name: 'file_read',
    description: 'Read a file from workspace storage',
    category: 'file',
    highRisk: false,
  },
  file_write: {
    name: 'file_write',
    description: 'Write a file to workspace storage',
    category: 'file',
    highRisk: false,
  },
  file_list: {
    name: 'file_list',
    description: 'List files in workspace storage',
    category: 'file',
    highRisk: false,
  },

  // Integration tools
  integration_webhook: {
    name: 'integration_webhook',
    description: 'Send data to a webhook',
    category: 'integration',
    highRisk: true,
  },
  integration_api_call: {
    name: 'integration_api_call',
    description: 'Make an API call to an external service',
    category: 'integration',
    highRisk: true,
  },
} as const;

export type GatewayToolName = keyof typeof GATEWAY_TOOLS;

@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);
  private readonly gatewayUrl: string;
  private readonly internalToken: string;
  private readonly timeoutMs: number;

  constructor(private readonly configService: ConfigService) {
    // Butler Service Gateway URL
    this.gatewayUrl = this.configService.get<string>(
      'BUTLER_GATEWAY_URL',
      'http://butler-gateway:8080',
    );

    // Internal service token for authenticated requests
    this.internalToken = this.configService.get<string>(
      'INTERNAL_SERVICE_TOKEN',
      '',
    );

    // Tool execution timeout (default 30 seconds)
    this.timeoutMs = parseInt(
      this.configService.get<string>('GATEWAY_TOOL_TIMEOUT_MS', '30000'),
      10,
    );

    this.logger.log(`Butler Gateway URL: ${this.gatewayUrl}`);
  }

  /**
   * Check if a tool is a gateway tool
   */
  isGatewayTool(toolName: string): boolean {
    return toolName in GATEWAY_TOOLS;
  }

  /**
   * Check if a tool is high-risk and requires approval
   */
  isHighRiskTool(toolName: string): boolean {
    const tool = GATEWAY_TOOLS[toolName as GatewayToolName];
    return tool?.highRisk ?? false;
  }

  /**
   * Get tool definition
   */
  getToolDefinition(toolName: string): (typeof GATEWAY_TOOLS)[GatewayToolName] | undefined {
    return GATEWAY_TOOLS[toolName as GatewayToolName];
  }

  /**
   * Get all available gateway tools
   */
  getAllTools(): (typeof GATEWAY_TOOLS)[GatewayToolName][] {
    return Object.values(GATEWAY_TOOLS);
  }

  /**
   * Filter tools by allowed list and high-risk list
   * Returns mutable GatewayToolDefinition[] since highRisk may be modified
   */
  filterTools(
    allowedTools?: string[],
    highRiskTools?: string[],
  ): GatewayToolDefinition[] {
    // Convert to mutable array
    let tools: GatewayToolDefinition[] = this.getAllTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      category: tool.category,
      highRisk: tool.highRisk,
    }));

    // Filter by allowed list if provided
    if (allowedTools && allowedTools.length > 0) {
      tools = tools.filter((tool) => allowedTools.includes(tool.name));
    }

    // Mark high-risk tools based on workflow configuration
    if (highRiskTools && highRiskTools.length > 0) {
      tools = tools.map((tool) => ({
        ...tool,
        highRisk: tool.highRisk || highRiskTools.includes(tool.name),
      }));
    }

    return tools;
  }

  /**
   * Execute a gateway tool
   */
  async executeTool(request: GatewayToolRequest): Promise<GatewayToolResult> {
    const startTime = Date.now();

    if (!this.isGatewayTool(request.toolName)) {
      return {
        success: false,
        error: `Unknown gateway tool: ${request.toolName}`,
        executionTimeMs: Date.now() - startTime,
      };
    }

    try {
      const url = `${this.gatewayUrl}/api/v1/tools/${request.toolName}/execute`;
      this.logger.log(`Executing gateway tool: ${request.toolName}`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Token': this.internalToken,
            ...(request.taskId && { 'X-Task-Id': request.taskId }),
            ...(request.nodeRunId && { 'X-Node-Run-Id': request.nodeRunId }),
            ...(request.workspaceId && { 'X-Workspace-Id': request.workspaceId }),
          },
          body: JSON.stringify({
            parameters: request.parameters,
          }),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const executionTimeMs = Date.now() - startTime;

        if (!response.ok) {
          const error = await response.json().catch(() => ({ message: 'Unknown error' }));

          // Handle approval-required response (HTTP 202)
          if (response.status === 202) {
            return {
              success: false,
              requiresApproval: true,
              approvalRequestId: error.approvalRequestId,
              error: error.message || 'This action requires human approval',
              executionTimeMs,
            };
          }

          return {
            success: false,
            error: error.message || `Gateway returned ${response.status}`,
            executionTimeMs,
          };
        }

        const result = await response.json();

        this.logger.log(
          `Gateway tool ${request.toolName} completed in ${executionTimeMs}ms`,
        );

        return {
          success: true,
          result: result.data,
          executionTimeMs,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error: any) {
      const executionTimeMs = Date.now() - startTime;

      if (error.name === 'AbortError') {
        return {
          success: false,
          error: `Tool execution timed out after ${this.timeoutMs}ms`,
          executionTimeMs,
        };
      }

      this.logger.error(
        `Gateway tool ${request.toolName} failed: ${error.message}`,
      );

      return {
        success: false,
        error: error.message,
        executionTimeMs,
      };
    }
  }

  /**
   * Check approval status for a pending action
   * v2.3.0 M5: Updated to use orchestrator's approval API
   */
  async checkApprovalStatus(approvalRequestId: string): Promise<{
    status: 'pending' | 'approved' | 'rejected' | 'expired';
    approvedAt?: string;
    rejectedAt?: string;
    reason?: string;
  }> {
    try {
      // Use orchestrator URL for approval checks
      const orchestratorUrl = this.configService.get<string>(
        'WORKFLOW_ORCHESTRATOR_URL',
        '',
      );

      if (!orchestratorUrl) {
        this.logger.warn('WORKFLOW_ORCHESTRATOR_URL not set, cannot check approval');
        return { status: 'pending' };
      }

      const url = `${orchestratorUrl}/api/v1/approvals/${approvalRequestId}`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.internalToken,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to check approval status: ${response.status}`);
      }

      const data = await response.json();
      const approval = data.approval;

      // Map status to expected format
      const statusMap: Record<string, 'pending' | 'approved' | 'rejected' | 'expired'> = {
        'PENDING': 'pending',
        'APPROVED': 'approved',
        'REJECTED': 'rejected',
        'EXPIRED': 'expired',
      };

      return {
        status: statusMap[approval.status] || 'pending',
        approvedAt: approval.decision?.at,
        rejectedAt: approval.decision?.at,
        reason: approval.decision?.reason,
      };
    } catch (error: any) {
      this.logger.error(`Failed to check approval status: ${error.message}`);
      return { status: 'pending' };
    }
  }

  /**
   * Request approval for a high-risk action
   * v2.3.0 M5: Creates approval request in orchestrator
   */
  async requestApproval(request: {
    nodeRunId: string;
    workspaceId: string;
    tenantId: string;
    toolName: string;
    toolParams: Record<string, any>;
    currentUrl?: string;
    aiReasoning?: string;
  }): Promise<{
    approvalRequestId: string;
    message: string;
    expiresAt: string;
  } | null> {
    try {
      const orchestratorUrl = this.configService.get<string>(
        'WORKFLOW_ORCHESTRATOR_URL',
        '',
      );

      if (!orchestratorUrl) {
        this.logger.warn('WORKFLOW_ORCHESTRATOR_URL not set, cannot request approval');
        return null;
      }

      const url = `${orchestratorUrl}/api/v1/approvals/request`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.internalToken,
        },
        body: JSON.stringify({
          nodeRunId: request.nodeRunId,
          workspaceId: request.workspaceId,
          tenantId: request.tenantId,
          toolName: request.toolName,
          toolParams: request.toolParams,
          currentUrl: request.currentUrl,
          aiReasoning: request.aiReasoning,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: 'Unknown error' }));
        throw new Error(error.message || `Request failed: ${response.status}`);
      }

      const data = await response.json();

      this.logger.log(`Created approval request: ${data.approval.id} for ${request.toolName}`);

      return {
        approvalRequestId: data.approval.id,
        message: 'Action requires human approval',
        expiresAt: data.approval.expiresAt,
      };
    } catch (error: any) {
      this.logger.error(`Failed to request approval: ${error.message}`);
      return null;
    }
  }

  /**
   * Execute a tool that has been approved
   */
  async executeApprovedTool(
    approvalRequestId: string,
    request: GatewayToolRequest,
  ): Promise<GatewayToolResult> {
    const startTime = Date.now();

    try {
      const url = `${this.gatewayUrl}/api/v1/tools/${request.toolName}/execute`;
      this.logger.log(`Executing approved tool: ${request.toolName}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': this.internalToken,
          'X-Approval-Id': approvalRequestId, // Pass approval ID for audit
        },
        body: JSON.stringify({
          parameters: request.parameters,
        }),
      });

      const executionTimeMs = Date.now() - startTime;

      if (!response.ok) {
        const error = await response.json().catch(() => ({ message: 'Unknown error' }));
        return {
          success: false,
          error: error.message || `Execution failed: ${response.status}`,
          executionTimeMs,
        };
      }

      const result = await response.json();

      return {
        success: true,
        result: result.data,
        executionTimeMs,
      };
    } catch (error: any) {
      const executionTimeMs = Date.now() - startTime;
      return {
        success: false,
        error: error.message,
        executionTimeMs,
      };
    }
  }
}
