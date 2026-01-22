/**
 * Node Executor Service
 * v2.0.0: Phase 7 Multi-Agent Orchestration
 *
 * Executes workflow nodes by dispatching tasks to agents.
 * Now supports multi-agent routing via AgentRouterService.
 *
 * Responsibilities:
 * - Execute different node types (TASK, DECISION, PARALLEL, WAIT)
 * - Route tasks to optimal agents using AgentRouterService
 * - Track task assignments for monitoring and debugging
 * - Collect results and update node status
 * - Release workspace locks after execution
 * - Handle agent failover for resilience
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import axios, { AxiosInstance } from 'axios';
import { PrismaService } from './prisma.service';
import { WorkspaceService } from './workspace.service';
import { NodeStatus } from './workflow.service';
import { AgentRouterService, RoutingRequest } from './agent-router.service';
import { AgentRegistryService, AgentInfo } from './agent-registry.service';

export interface NodeExecutionResult {
  success: boolean;
  output?: any;
  error?: string;
  artifacts?: Array<{
    type: string;
    path: string;
    name: string;
  }>;
  agentId?: string;
  routingReason?: string;
}

@Injectable()
export class NodeExecutorService {
  private readonly logger = new Logger(NodeExecutorService.name);
  private readonly defaultAgentClient: AxiosInstance;
  private readonly taskTimeout: number;
  private readonly enableMultiAgent: boolean;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private workspaceService: WorkspaceService,
    private eventEmitter: EventEmitter2,
    private agentRouter: AgentRouterService,
    private agentRegistry: AgentRegistryService,
  ) {
    // Default agent URL (backward compatibility)
    const agentUrl = this.configService.get<string>(
      'AGENT_SERVICE_URL',
      'http://bytebot-agent:8080',
    );

    // Task execution timeout (default: 10 minutes)
    this.taskTimeout = parseInt(
      this.configService.get<string>('TASK_EXECUTION_TIMEOUT_MS', '600000'),
      10,
    );

    // Multi-agent mode enable flag
    this.enableMultiAgent =
      this.configService.get<string>('MULTI_AGENT_ENABLED', 'true') === 'true';

    this.defaultAgentClient = axios.create({
      baseURL: agentUrl,
      timeout: this.taskTimeout,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    this.logger.log(
      `NodeExecutor initialized (multiAgent: ${this.enableMultiAgent}, timeout: ${this.taskTimeout}ms)`,
    );
  }

  /**
   * Create an axios client for a specific agent
   */
  private createAgentClient(agent: AgentInfo): AxiosInstance {
    return axios.create({
      baseURL: agent.endpoint,
      timeout: this.taskTimeout,
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Id': agent.id,
        'X-Agent-Name': agent.name,
      },
    });
  }

  /**
   * Execute a workflow node
   *
   * This is the main entry point called by the scheduler.
   * It routes to the appropriate execution handler based on node type.
   */
  async executeNode(node: any, workflow: any): Promise<void> {
    this.logger.log(`Executing node ${node.id} (${node.type}): ${node.name}`);

    const startTime = Date.now();

    try {
      let result: NodeExecutionResult;

      switch (node.type) {
        case 'TASK':
          result = await this.executeTaskNode(node, workflow);
          break;
        case 'DECISION':
          result = await this.executeDecisionNode(node, workflow);
          break;
        case 'PARALLEL':
          result = await this.executeParallelNode(node, workflow);
          break;
        case 'WAIT':
          result = await this.executeWaitNode(node, workflow);
          break;
        default:
          throw new Error(`Unknown node type: ${node.type}`);
      }

      // Update node status
      await this.prisma.workflowNode.update({
        where: { id: node.id },
        data: {
          status: result.success ? NodeStatus.COMPLETED : NodeStatus.FAILED,
          output: result.output,
          error: result.error,
          completedAt: new Date(),
          durationMs: Date.now() - startTime,
        },
      });

      // Release workspace lock
      await this.workspaceService.releaseLock(workflow.workspaceId, node.id);

      this.eventEmitter.emit('node.completed', {
        nodeId: node.id,
        workflowId: workflow.id,
        success: result.success,
        durationMs: Date.now() - startTime,
      });

      this.logger.log(
        `Node ${node.id} completed in ${Date.now() - startTime}ms: ${
          result.success ? 'success' : 'failed'
        }`,
      );
    } catch (error: any) {
      this.logger.error(`Node ${node.id} execution failed: ${error.message}`);

      // Update node status to failed
      await this.prisma.workflowNode.update({
        where: { id: node.id },
        data: {
          status: NodeStatus.FAILED,
          error: error.message,
          completedAt: new Date(),
          durationMs: Date.now() - startTime,
        },
      });

      // Release workspace lock
      await this.workspaceService.releaseLock(workflow.workspaceId, node.id);

      this.eventEmitter.emit('node.failed', {
        nodeId: node.id,
        workflowId: workflow.id,
        error: error.message,
      });
    }
  }

  /**
   * Execute a TASK node by dispatching to agent
   * Phase 7: Now supports multi-agent routing
   */
  private async executeTaskNode(
    node: any,
    workflow: any,
  ): Promise<NodeExecutionResult> {
    const config = node.config as any;

    // Get workspace desktop endpoint
    const workspaceStatus = await this.workspaceService.getWorkspaceDesktopStatus(
      workflow.workspaceId,
    );

    if (workspaceStatus.status !== 'READY') {
      throw new Error(
        `Workspace not ready: ${workspaceStatus.status} - ${workspaceStatus.message}`,
      );
    }

    // Build task request for agent
    const taskRequest = {
      taskId: node.id,
      workflowId: workflow.id,
      workspaceId: workflow.workspaceId,
      desktopEndpoint: workspaceStatus.desktopEndpoint,
      vncEndpoint: workspaceStatus.vncEndpoint,
      prompt: config.prompt,
      tools: config.tools || [],
      maxIterations: config.maxIterations || 50,
      timeout: config.timeout || 300000, // 5 minutes default
      context: {
        workflowName: workflow.name,
        nodeName: node.name,
        previousOutputs: await this.getPreviousOutputs(node),
      },
    };

    // Select agent using multi-agent routing
    let selectedAgent: AgentInfo | null = null;
    let routingReason = 'default';
    let agentClient: AxiosInstance = this.defaultAgentClient;

    if (this.enableMultiAgent) {
      // Build routing request
      const routingRequest: RoutingRequest = {
        nodeId: node.id,
        workflowId: workflow.id,
        workspaceId: workflow.workspaceId,
        requiredTools: config.tools || [],
        preferredAgentId: config.preferredAgentId,
        affinityNodeIds: node.dependencies as string[],
        requiresExclusiveWorkspace: !config.gatewayToolsOnly,
      };

      // Route to optimal agent
      const routingResult = await this.agentRouter.routeTask(routingRequest);

      if (routingResult) {
        selectedAgent = routingResult.agent;
        routingReason = routingResult.reason;
        agentClient = this.createAgentClient(selectedAgent);

        this.logger.log(
          `Task ${node.id} routed to agent ${selectedAgent.name} ` +
            `(${selectedAgent.id}) via ${routingReason}`,
        );

        // Record the assignment
        await this.agentRouter.recordAssignment(
          node.id,
          selectedAgent.id,
          routingReason,
        );
      } else {
        this.logger.warn(
          `No agent available for task ${node.id}, falling back to default`,
        );
      }
    }

    // Dispatch to agent
    try {
      const response = await agentClient.post('/api/v1/tasks/execute', taskRequest);

      // Mark assignment as completed
      if (selectedAgent) {
        await this.agentRouter.completeAssignment(
          node.id,
          selectedAgent.id,
          response.data.success,
          response.data.output,
          response.data.error,
        );
      }

      return {
        success: response.data.success,
        output: response.data.output,
        error: response.data.error,
        artifacts: response.data.artifacts,
        agentId: selectedAgent?.id,
        routingReason,
      };
    } catch (error: any) {
      // Mark assignment as failed
      if (selectedAgent) {
        await this.agentRouter.completeAssignment(
          node.id,
          selectedAgent.id,
          false,
          undefined,
          error.response?.data?.message || error.message,
        );
      }

      // Try failover to alternative agent if available
      if (this.enableMultiAgent && selectedAgent) {
        const failoverResult = await this.tryFailover(
          node,
          workflow,
          taskRequest,
          selectedAgent.id,
          error.message,
        );
        if (failoverResult) {
          return failoverResult;
        }
      }

      return {
        success: false,
        error: error.response?.data?.message || error.message,
        agentId: selectedAgent?.id,
        routingReason,
      };
    }
  }

  /**
   * Try to failover to an alternative agent
   */
  private async tryFailover(
    node: any,
    workflow: any,
    taskRequest: any,
    failedAgentId: string,
    failureReason: string,
  ): Promise<NodeExecutionResult | null> {
    const config = node.config as any;

    // Build routing request excluding failed agent
    const routingRequest: RoutingRequest = {
      nodeId: node.id,
      workflowId: workflow.id,
      workspaceId: workflow.workspaceId,
      requiredTools: config.tools || [],
      requiresExclusiveWorkspace: !config.gatewayToolsOnly,
    };

    // Get alternative agent
    const routingResult = await this.agentRouter.routeTask(routingRequest);

    if (
      !routingResult ||
      routingResult.agent.id === failedAgentId ||
      routingResult.alternativeAgents.length === 0
    ) {
      return null;
    }

    // Use the first alternative
    const alternativeAgent = routingResult.alternativeAgents[0].agent;

    this.logger.log(
      `Failing over task ${node.id} from agent ${failedAgentId} ` +
        `to ${alternativeAgent.name} (${alternativeAgent.id}): ${failureReason}`,
    );

    // Reassign the task
    await this.agentRouter.reassignTask(
      node.id,
      failedAgentId,
      alternativeAgent.id,
      `failover: ${failureReason}`,
    );

    // Create client and dispatch
    const agentClient = this.createAgentClient(alternativeAgent);

    try {
      const response = await agentClient.post('/api/v1/tasks/execute', taskRequest);

      await this.agentRouter.completeAssignment(
        node.id,
        alternativeAgent.id,
        response.data.success,
        response.data.output,
        response.data.error,
      );

      return {
        success: response.data.success,
        output: response.data.output,
        error: response.data.error,
        artifacts: response.data.artifacts,
        agentId: alternativeAgent.id,
        routingReason: 'failover',
      };
    } catch (error: any) {
      await this.agentRouter.completeAssignment(
        node.id,
        alternativeAgent.id,
        false,
        undefined,
        error.response?.data?.message || error.message,
      );

      return null;
    }
  }

  /**
   * Execute a DECISION node (conditional branching)
   */
  private async executeDecisionNode(
    node: any,
    workflow: any,
  ): Promise<NodeExecutionResult> {
    const config = node.config as any;

    // Get previous outputs for condition evaluation
    const previousOutputs = await this.getPreviousOutputs(node);

    // Simple condition evaluation
    // In a real implementation, this would use a proper expression evaluator
    let selectedBranch: string | null = null;

    for (const condition of config.conditions || []) {
      if (this.evaluateCondition(condition.expression, previousOutputs)) {
        selectedBranch = condition.targetNodeId;
        break;
      }
    }

    // Use default branch if no condition matched
    if (!selectedBranch && config.defaultBranch) {
      selectedBranch = config.defaultBranch;
    }

    if (!selectedBranch) {
      return {
        success: false,
        error: 'No matching condition and no default branch',
      };
    }

    // Mark the selected branch as ready
    await this.prisma.workflowNode.update({
      where: { id: selectedBranch },
      data: { status: NodeStatus.READY },
    });

    // Skip non-selected branches
    const allBranches = [
      ...(config.conditions?.map((c: any) => c.targetNodeId) || []),
      config.defaultBranch,
    ].filter(Boolean);

    const skippedBranches = allBranches.filter((b: string) => b !== selectedBranch);
    if (skippedBranches.length > 0) {
      await this.prisma.workflowNode.updateMany({
        where: { id: { in: skippedBranches } },
        data: { status: NodeStatus.SKIPPED },
      });
    }

    return {
      success: true,
      output: {
        selectedBranch,
        skippedBranches,
      },
    };
  }

  /**
   * Execute a PARALLEL node (fan-out to multiple tasks)
   */
  private async executeParallelNode(
    node: any,
    workflow: any,
  ): Promise<NodeExecutionResult> {
    const config = node.config as any;

    // Mark all parallel branches as ready
    const parallelNodeIds = config.parallelNodeIds || [];

    await this.prisma.workflowNode.updateMany({
      where: { id: { in: parallelNodeIds } },
      data: { status: NodeStatus.READY },
    });

    return {
      success: true,
      output: {
        dispatchedNodes: parallelNodeIds,
      },
    };
  }

  /**
   * Execute a WAIT node (delay or wait for condition)
   */
  private async executeWaitNode(
    node: any,
    workflow: any,
  ): Promise<NodeExecutionResult> {
    const config = node.config as any;

    // Simple delay wait
    if (config.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    }

    // In a real implementation, this could wait for:
    // - External webhook
    // - Time-based condition
    // - Manual approval
    // - Resource availability

    return {
      success: true,
      output: {
        waitedMs: config.delayMs || 0,
      },
    };
  }

  /**
   * Get outputs from previous nodes (dependencies)
   */
  private async getPreviousOutputs(node: any): Promise<Record<string, any>> {
    const dependencies = node.dependencies as string[];
    if (!dependencies || dependencies.length === 0) {
      return {};
    }

    const previousNodes = await this.prisma.workflowNode.findMany({
      where: { id: { in: dependencies } },
    });

    const outputs: Record<string, any> = {};
    for (const prevNode of previousNodes) {
      outputs[prevNode.id] = prevNode.output;
      outputs[prevNode.name] = prevNode.output;
    }

    return outputs;
  }

  /**
   * Simple condition evaluation
   * In production, use a proper expression evaluator
   */
  private evaluateCondition(
    expression: string,
    context: Record<string, any>,
  ): boolean {
    try {
      // Very simple evaluation - just check for truthy values
      // Production should use a sandboxed expression evaluator
      const parts = expression.split('.');
      let value: any = context;

      for (const part of parts) {
        if (value && typeof value === 'object') {
          value = value[part];
        } else {
          return false;
        }
      }

      return Boolean(value);
    } catch {
      return false;
    }
  }
}
