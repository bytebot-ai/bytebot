/**
 * Dependency Inference Service
 * v1.0.0: Nice-to-Have Enhancement for Step Ordering
 *
 * Implements LLM-based dependency inference for workflow steps:
 * - Analyzes step descriptions to identify dependencies
 * - Builds DAG (Directed Acyclic Graph) for execution order
 * - Detects circular dependencies
 * - Calculates execution levels for parallel execution
 *
 * Enhances the planner by automatically ordering steps based on
 * their logical dependencies rather than just sequential order.
 *
 * @see /docs/CONTEXT_PROPAGATION_FIX_JAN_2026.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Step input for dependency analysis
export interface StepInput {
  id: string;
  description: string;
  order: number;
}

// Step with inferred dependencies
export interface StepWithDependencies {
  id: string;
  description: string;
  order: number;
  dependsOn: string[];        // IDs of prerequisite steps
  reasoning: string;          // Why these dependencies exist
  confidence: number;         // Confidence in the inference (0-1)
}

// Dependency analysis result
export interface DependencyAnalysisResult {
  steps: StepWithDependencies[];
  hasCircularDependency: boolean;
  executionLevels: string[][];  // Steps grouped by execution level
  criticalPath: string[];       // Longest path through the DAG
  parallelizationPotential: number; // 0-1, how much can be parallelized
}

// DAG node for execution ordering
interface DAGNode {
  id: string;
  dependencies: string[];
  dependents: string[];
  inDegree: number;
  level: number;
}

@Injectable()
export class DependencyInferenceService {
  private readonly logger = new Logger(DependencyInferenceService.name);
  private readonly enabled: boolean;
  private readonly llmApiKey: string;
  private readonly llmApiUrl: string;
  private readonly llmModel: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.enabled = this.configService.get('DEPENDENCY_INFERENCE_ENABLED', 'true') === 'true';
    this.llmApiKey = this.configService.get('LLM_API_KEY', '');
    this.llmApiUrl = this.configService.get('LLM_API_URL', 'https://api.anthropic.com/v1/messages');
    this.llmModel = this.configService.get('LLM_MODEL', 'claude-3-5-sonnet-20241022');
    this.logger.log(`Dependency inference ${this.enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Infer dependencies between workflow steps
   *
   * Uses the LLM to analyze step descriptions and identify
   * which steps depend on others. Returns a DAG structure
   * that can be used for parallel execution planning.
   */
  async inferDependencies(
    goalDescription: string,
    steps: StepInput[],
  ): Promise<DependencyAnalysisResult> {
    if (!this.enabled || steps.length < 2) {
      // Return simple sequential order if disabled or too few steps
      return this.createSequentialResult(steps);
    }

    this.logger.log(`Inferring dependencies for ${steps.length} steps`);

    try {
      // Use LLM to analyze dependencies
      const stepsWithDeps = await this.analyzeWithLLM(goalDescription, steps);

      // Detect and handle circular dependencies
      const hasCircular = this.detectCircularDependencies(stepsWithDeps);
      if (hasCircular) {
        this.logger.warn('Circular dependency detected, falling back to sequential order');
        return this.createSequentialResult(steps);
      }

      // Build DAG and calculate execution levels
      const dag = this.buildDAG(stepsWithDeps);
      const executionLevels = this.calculateExecutionLevels(dag);
      const criticalPath = this.calculateCriticalPath(dag);
      const parallelizationPotential = this.calculateParallelizationPotential(
        steps.length,
        executionLevels.length,
      );

      const result: DependencyAnalysisResult = {
        steps: stepsWithDeps,
        hasCircularDependency: false,
        executionLevels,
        criticalPath,
        parallelizationPotential,
      };

      // Emit event for monitoring
      this.eventEmitter.emit('dependency.inferred', {
        stepCount: steps.length,
        levelCount: executionLevels.length,
        parallelizationPotential,
      });

      this.logger.log(
        `Inferred dependencies: ${executionLevels.length} levels, ` +
        `${(parallelizationPotential * 100).toFixed(1)}% parallelizable`,
      );

      return result;
    } catch (error) {
      this.logger.error(`Dependency inference failed: ${(error as Error).message}`);
      // Fall back to sequential order on error
      return this.createSequentialResult(steps);
    }
  }

  /**
   * Check if step A depends on step B
   */
  hasDependency(
    analysisResult: DependencyAnalysisResult,
    stepId: string,
    dependsOnId: string,
  ): boolean {
    const step = analysisResult.steps.find((s) => s.id === stepId);
    return step?.dependsOn.includes(dependsOnId) || false;
  }

  /**
   * Get steps that can run in parallel at a given level
   */
  getParallelSteps(
    analysisResult: DependencyAnalysisResult,
    level: number,
  ): string[] {
    return analysisResult.executionLevels[level] || [];
  }

  /**
   * Get the execution level for a step
   */
  getStepLevel(
    analysisResult: DependencyAnalysisResult,
    stepId: string,
  ): number {
    for (let level = 0; level < analysisResult.executionLevels.length; level++) {
      if (analysisResult.executionLevels[level].includes(stepId)) {
        return level;
      }
    }
    return -1; // Not found
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  /**
   * Use LLM to analyze step dependencies
   */
  private async analyzeWithLLM(
    goalDescription: string,
    steps: StepInput[],
  ): Promise<StepWithDependencies[]> {
    const prompt = this.buildAnalysisPrompt(goalDescription, steps);

    try {
      const response = await this.callLLM(prompt);

      // Parse LLM response
      const parsed = this.parseLLMResponse(response, steps);
      return parsed;
    } catch (error) {
      this.logger.error(`LLM dependency analysis failed: ${(error as Error).message}`);
      // Return steps with no dependencies (sequential fallback)
      return steps.map((step, index) => ({
        ...step,
        dependsOn: index > 0 ? [steps[index - 1].id] : [],
        reasoning: 'Fallback to sequential order',
        confidence: 0.5,
      }));
    }
  }

  /**
   * Call LLM API directly (similar to PlannerService pattern)
   */
  private async callLLM(prompt: string): Promise<string> {
    // If no API key, return mock response for development
    if (!this.llmApiKey) {
      this.logger.warn('No LLM API key configured, using fallback');
      return '{"steps": []}';
    }

    const response = await fetch(this.llmApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.llmApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.llmModel,
        max_tokens: 2000,
        temperature: 0, // Deterministic for consistency
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text || '';
  }

  /**
   * Build the prompt for dependency analysis
   */
  private buildAnalysisPrompt(goalDescription: string, steps: StepInput[]): string {
    const stepsText = steps
      .map((s) => `- ID: "${s.id}", Step ${s.order + 1}: "${s.description}"`)
      .join('\n');

    return `You are analyzing workflow step dependencies. Given a goal and list of steps,
identify which steps depend on other steps.

Rules for dependency detection:
1. A step depends on another if it requires the OUTPUT or COMPLETION of that step
2. Look for temporal indicators: "after", "once", "when", "then", "using the"
3. Look for data dependencies: step B uses data that step A creates
4. Look for resource dependencies: step B needs a resource that step A sets up
5. Steps with NO dependencies can run in parallel
6. Do NOT create circular dependencies

Goal: ${goalDescription}

Steps to analyze:
${stepsText}

Respond with a JSON object in this exact format:
{
  "steps": [
    {
      "id": "<step_id>",
      "dependsOn": ["<id_of_prerequisite_step>", ...],
      "reasoning": "<brief explanation of why this step depends on others>",
      "confidence": <number between 0 and 1>
    }
  ]
}

For steps with no dependencies, use an empty array: "dependsOn": []
Be conservative - only add a dependency if there's a clear logical requirement.`;
  }

  /**
   * Parse LLM response into structured format
   */
  private parseLLMResponse(
    response: string,
    originalSteps: StepInput[],
  ): StepWithDependencies[] {
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonStr = response;
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }

      const parsed = JSON.parse(jsonStr.trim());

      if (!parsed.steps || !Array.isArray(parsed.steps)) {
        throw new Error('Invalid response format: missing steps array');
      }

      // Map parsed response back to original steps
      return originalSteps.map((step) => {
        const analyzed = parsed.steps.find((s: any) => s.id === step.id);
        return {
          ...step,
          dependsOn: analyzed?.dependsOn || [],
          reasoning: analyzed?.reasoning || 'No dependencies identified',
          confidence: analyzed?.confidence || 0.8,
        };
      });
    } catch (error) {
      this.logger.error(`Failed to parse LLM response: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Detect circular dependencies using DFS
   */
  private detectCircularDependencies(steps: StepWithDependencies[]): boolean {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const stepMap = new Map(steps.map((s) => [s.id, s]));

    const hasCycle = (stepId: string): boolean => {
      if (recursionStack.has(stepId)) return true;
      if (visited.has(stepId)) return false;

      visited.add(stepId);
      recursionStack.add(stepId);

      const step = stepMap.get(stepId);
      if (step) {
        for (const depId of step.dependsOn) {
          if (hasCycle(depId)) return true;
        }
      }

      recursionStack.delete(stepId);
      return false;
    };

    for (const step of steps) {
      if (hasCycle(step.id)) return true;
    }
    return false;
  }

  /**
   * Build DAG from steps with dependencies
   */
  private buildDAG(steps: StepWithDependencies[]): Map<string, DAGNode> {
    const nodes = new Map<string, DAGNode>();

    // Initialize nodes
    for (const step of steps) {
      nodes.set(step.id, {
        id: step.id,
        dependencies: [...step.dependsOn],
        dependents: [],
        inDegree: step.dependsOn.length,
        level: 0,
      });
    }

    // Build reverse edges (dependents)
    for (const step of steps) {
      for (const depId of step.dependsOn) {
        const depNode = nodes.get(depId);
        if (depNode) {
          depNode.dependents.push(step.id);
        }
      }
    }

    return nodes;
  }

  /**
   * Calculate execution levels using Kahn's algorithm (topological sort)
   * Level 0: No dependencies (can start immediately)
   * Level N: All dependencies from levels 0 to N-1
   */
  private calculateExecutionLevels(dag: Map<string, DAGNode>): string[][] {
    const levels: string[][] = [];
    const inDegree = new Map<string, number>();
    const remaining = new Set<string>();

    // Initialize in-degrees
    for (const [id, node] of dag) {
      inDegree.set(id, node.inDegree);
      remaining.add(id);
    }

    while (remaining.size > 0) {
      const currentLevel: string[] = [];

      // Find all nodes with in-degree 0
      for (const nodeId of remaining) {
        if (inDegree.get(nodeId) === 0) {
          currentLevel.push(nodeId);
        }
      }

      if (currentLevel.length === 0 && remaining.size > 0) {
        // Should not happen if no cycles, but safety check
        this.logger.error('Cycle detected during level calculation');
        break;
      }

      // Remove processed nodes and update in-degrees
      for (const nodeId of currentLevel) {
        remaining.delete(nodeId);
        const node = dag.get(nodeId)!;

        for (const dependentId of node.dependents) {
          const degree = inDegree.get(dependentId) || 0;
          inDegree.set(dependentId, degree - 1);
        }
      }

      if (currentLevel.length > 0) {
        levels.push(currentLevel);
      }
    }

    return levels;
  }

  /**
   * Calculate the critical path (longest path through DAG)
   */
  private calculateCriticalPath(dag: Map<string, DAGNode>): string[] {
    const distances = new Map<string, number>();
    const predecessors = new Map<string, string | null>();

    // Initialize
    for (const nodeId of dag.keys()) {
      distances.set(nodeId, 0);
      predecessors.set(nodeId, null);
    }

    // Topological order processing
    const sorted = this.topologicalSort(dag);

    for (const nodeId of sorted) {
      const node = dag.get(nodeId)!;
      const currentDist = distances.get(nodeId)!;

      for (const dependentId of node.dependents) {
        const newDist = currentDist + 1;
        if (newDist > distances.get(dependentId)!) {
          distances.set(dependentId, newDist);
          predecessors.set(dependentId, nodeId);
        }
      }
    }

    // Find the node with maximum distance
    let maxNode = sorted[0];
    let maxDist = 0;
    for (const [nodeId, dist] of distances) {
      if (dist > maxDist) {
        maxDist = dist;
        maxNode = nodeId;
      }
    }

    // Reconstruct path
    const path: string[] = [];
    let current: string | null = maxNode;
    while (current) {
      path.unshift(current);
      current = predecessors.get(current) || null;
    }

    return path;
  }

  /**
   * Topological sort using Kahn's algorithm
   */
  private topologicalSort(dag: Map<string, DAGNode>): string[] {
    const result: string[] = [];
    const inDegree = new Map<string, number>();
    const queue: string[] = [];

    // Calculate in-degrees
    for (const [id, node] of dag) {
      inDegree.set(id, node.inDegree);
      if (node.inDegree === 0) {
        queue.push(id);
      }
    }

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      result.push(nodeId);

      const node = dag.get(nodeId)!;
      for (const dependentId of node.dependents) {
        const newDegree = inDegree.get(dependentId)! - 1;
        inDegree.set(dependentId, newDegree);
        if (newDegree === 0) {
          queue.push(dependentId);
        }
      }
    }

    return result;
  }

  /**
   * Calculate parallelization potential
   * 1.0 = all steps can run in parallel (unlikely)
   * 0.0 = all steps must run sequentially
   */
  private calculateParallelizationPotential(
    totalSteps: number,
    levelCount: number,
  ): number {
    if (totalSteps <= 1) return 0;
    if (levelCount <= 1) return 1;

    // Ideal parallelization: all steps in 1 level
    // Worst case: each step in its own level (sequential)
    // Score = 1 - (levels - 1) / (steps - 1)
    return 1 - (levelCount - 1) / (totalSteps - 1);
  }

  /**
   * Create a simple sequential result (fallback)
   */
  private createSequentialResult(steps: StepInput[]): DependencyAnalysisResult {
    const stepsWithDeps: StepWithDependencies[] = steps.map((step, index) => ({
      ...step,
      dependsOn: index > 0 ? [steps[index - 1].id] : [],
      reasoning: 'Sequential order (default)',
      confidence: 1.0,
    }));

    const executionLevels = steps.map((s) => [s.id]);
    const criticalPath = steps.map((s) => s.id);

    return {
      steps: stepsWithDeps,
      hasCircularDependency: false,
      executionLevels,
      criticalPath,
      parallelizationPotential: 0,
    };
  }
}
