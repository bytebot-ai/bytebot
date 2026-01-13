/**
 * Goal Template Service
 * Phase 7: Enhanced Features
 *
 * Responsibilities:
 * - CRUD operations for goal templates
 * - Template instantiation (converting templates to goal runs)
 * - Variable substitution and validation
 * - Template versioning and publishing
 * - Usage tracking and analytics
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import { GoalRunService, GoalConstraints, CreateGoalRunInput } from './goal-run.service';
import { createId } from '@paralleldrive/cuid2';
import { Prisma } from '@prisma/client';

// Input types
export interface CreateGoalTemplateInput {
  tenantId: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  icon?: string;
  goalPattern: string;
  defaultConstraints?: GoalConstraints;
  variables?: TemplateVariable[];
  checklistTemplate?: ChecklistTemplateItem[];
  createdBy?: string;
}

export interface UpdateGoalTemplateInput {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  icon?: string;
  goalPattern?: string;
  defaultConstraints?: GoalConstraints;
  variables?: TemplateVariable[];
  checklistTemplate?: ChecklistTemplateItem[];
}

export interface TemplateVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  required: boolean;
  default?: string | number | boolean;
  description?: string;
  options?: string[]; // For select type
  validation?: {
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    pattern?: string;
  };
}

export interface ChecklistTemplateItem {
  order: number;
  descriptionTemplate: string; // Template with {{variables}}
  expectedOutcomeTemplate?: string;
  suggestedTools?: string[];
  requiresDesktop?: boolean;
}

export interface CreateFromTemplateInput {
  tenantId: string;
  templateId: string;
  variableValues: Record<string, string | number | boolean>;
  constraintOverrides?: Partial<GoalConstraints>;
  autoStart?: boolean;
}

// Response types
export interface GoalTemplateResponse {
  id: string;
  tenantId: string;
  name: string;
  description?: string | null;
  category?: string | null;
  tags: string[];
  icon?: string | null;
  goalPattern: string;
  defaultConstraints: GoalConstraints;
  variables: TemplateVariable[];
  checklistTemplate: ChecklistTemplateItem[];
  version: string;
  isLatest: boolean;
  isPublished: boolean;
  isBuiltIn: boolean;
  usageCount: number;
  lastUsedAt?: Date | null;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface GoalTemplateFilters {
  category?: string;
  tags?: string[];
  isPublished?: boolean;
  isBuiltIn?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class GoalTemplateService {
  private readonly logger = new Logger(GoalTemplateService.name);

  constructor(
    private prisma: PrismaService,
    private goalRunService: GoalRunService,
    private eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new goal template
   */
  async create(input: CreateGoalTemplateInput): Promise<GoalTemplateResponse> {
    const templateId = `gt-${createId()}`;

    this.logger.log(`Creating goal template ${templateId}: "${input.name}"`);

    // Validate variables in goal pattern
    this.validateGoalPattern(input.goalPattern, input.variables || []);

    // Check for duplicate name
    const existing = await this.prisma.goalTemplate.findFirst({
      where: {
        tenantId: input.tenantId,
        name: input.name,
        isLatest: true,
      },
    });

    if (existing) {
      throw new ConflictException(`Template with name "${input.name}" already exists`);
    }

    const template = await this.prisma.goalTemplate.create({
      data: {
        id: templateId,
        tenantId: input.tenantId,
        name: input.name,
        description: input.description,
        category: input.category,
        tags: input.tags || [],
        icon: input.icon,
        goalPattern: input.goalPattern,
        defaultConstraints: (input.defaultConstraints || {}) as object,
        variables: (input.variables || []) as object,
        checklistTemplate: (input.checklistTemplate || []) as object,
        version: '1.0.0',
        isLatest: true,
        isPublished: false,
        isBuiltIn: false,
        createdBy: input.createdBy,
      },
    });

    this.eventEmitter.emit('goal-template.created', {
      templateId,
      tenantId: input.tenantId,
      name: input.name,
    });

    return this.toTemplateResponse(template);
  }

  /**
   * Get template by ID
   */
  async findById(templateId: string): Promise<GoalTemplateResponse> {
    const template = await this.prisma.goalTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    return this.toTemplateResponse(template);
  }

  /**
   * List templates for a tenant
   */
  async findByTenant(
    tenantId: string,
    filters?: GoalTemplateFilters,
  ): Promise<PaginatedResponse<GoalTemplateResponse>> {
    const page = filters?.page || 1;
    const pageSize = filters?.pageSize || 20;
    const skip = (page - 1) * pageSize;

    const where: Prisma.GoalTemplateWhereInput = {
      OR: [
        { tenantId },
        { isBuiltIn: true }, // Include built-in templates for all tenants
      ],
      isLatest: true,
      ...(filters?.category && { category: filters.category }),
      ...(filters?.isPublished !== undefined && { isPublished: filters.isPublished }),
      ...(filters?.isBuiltIn !== undefined && { isBuiltIn: filters.isBuiltIn }),
      ...(filters?.tags?.length && { tags: { hasSome: filters.tags } }),
      ...(filters?.search && {
        OR: [
          { name: { contains: filters.search, mode: Prisma.QueryMode.insensitive } },
          { description: { contains: filters.search, mode: Prisma.QueryMode.insensitive } },
        ],
      }),
    };

    const [templates, total] = await Promise.all([
      this.prisma.goalTemplate.findMany({
        where,
        orderBy: [{ usageCount: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: pageSize,
      }),
      this.prisma.goalTemplate.count({ where }),
    ]);

    return {
      data: templates.map(this.toTemplateResponse),
      total,
      page,
      pageSize,
      hasMore: skip + templates.length < total,
    };
  }

  /**
   * Get templates by category
   */
  async findByCategory(tenantId: string, category: string): Promise<GoalTemplateResponse[]> {
    const templates = await this.prisma.goalTemplate.findMany({
      where: {
        OR: [{ tenantId }, { isBuiltIn: true }],
        category,
        isLatest: true,
        isPublished: true,
      },
      orderBy: { usageCount: 'desc' },
    });

    return templates.map(this.toTemplateResponse);
  }

  /**
   * Get all categories for a tenant
   */
  async getCategories(tenantId: string): Promise<{ category: string; count: number }[]> {
    const categories = await this.prisma.goalTemplate.groupBy({
      by: ['category'],
      where: {
        OR: [{ tenantId }, { isBuiltIn: true }],
        isLatest: true,
        isPublished: true,
        category: { not: null },
      },
      _count: { category: true },
    });

    return categories
      .filter((c) => c.category)
      .map((c) => ({
        category: c.category!,
        count: c._count.category,
      }));
  }

  /**
   * Update a template (creates new version)
   */
  async update(
    templateId: string,
    input: UpdateGoalTemplateInput,
  ): Promise<GoalTemplateResponse> {
    const existing = await this.prisma.goalTemplate.findUnique({
      where: { id: templateId },
    });

    if (!existing) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    if (existing.isBuiltIn) {
      throw new BadRequestException('Cannot update built-in templates');
    }

    // Validate if goal pattern changed
    if (input.goalPattern) {
      const variables = input.variables || (existing.variables as unknown as TemplateVariable[]);
      this.validateGoalPattern(input.goalPattern, variables);
    }

    const template = await this.prisma.goalTemplate.update({
      where: { id: templateId },
      data: {
        name: input.name,
        description: input.description,
        category: input.category,
        tags: input.tags,
        icon: input.icon,
        goalPattern: input.goalPattern,
        ...(input.defaultConstraints && {
          defaultConstraints: input.defaultConstraints as object,
        }),
        ...(input.variables && { variables: input.variables as object }),
        ...(input.checklistTemplate && {
          checklistTemplate: input.checklistTemplate as object,
        }),
      },
    });

    this.eventEmitter.emit('goal-template.updated', {
      templateId,
      tenantId: template.tenantId,
    });

    return this.toTemplateResponse(template);
  }

  /**
   * Create new version of a template
   */
  async createNewVersion(
    templateId: string,
    input: UpdateGoalTemplateInput,
  ): Promise<GoalTemplateResponse> {
    const existing = await this.prisma.goalTemplate.findUnique({
      where: { id: templateId },
    });

    if (!existing) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    // Parse and increment version
    const [major, minor, patch] = existing.version.split('.').map(Number);
    const newVersion = `${major}.${minor}.${patch + 1}`;

    // Mark old version as not latest
    await this.prisma.goalTemplate.update({
      where: { id: templateId },
      data: { isLatest: false },
    });

    // Create new version
    const newTemplateId = `gt-${createId()}`;
    const template = await this.prisma.goalTemplate.create({
      data: {
        id: newTemplateId,
        tenantId: existing.tenantId,
        name: input.name || existing.name,
        description: input.description ?? existing.description,
        category: input.category ?? existing.category,
        tags: input.tags || existing.tags,
        icon: input.icon ?? existing.icon,
        goalPattern: input.goalPattern || existing.goalPattern,
        defaultConstraints: (input.defaultConstraints ||
          existing.defaultConstraints) as object,
        variables: (input.variables || existing.variables) as object,
        checklistTemplate: (input.checklistTemplate ||
          existing.checklistTemplate) as object,
        version: newVersion,
        isLatest: true,
        isPublished: existing.isPublished,
        isBuiltIn: false,
        previousVersionId: templateId,
        createdBy: existing.createdBy,
      },
    });

    this.eventEmitter.emit('goal-template.version-created', {
      templateId: newTemplateId,
      previousId: templateId,
      version: newVersion,
    });

    return this.toTemplateResponse(template);
  }

  /**
   * Publish a template
   */
  async publish(templateId: string): Promise<GoalTemplateResponse> {
    const template = await this.prisma.goalTemplate.update({
      where: { id: templateId },
      data: { isPublished: true },
    });

    this.eventEmitter.emit('goal-template.published', {
      templateId,
      tenantId: template.tenantId,
    });

    return this.toTemplateResponse(template);
  }

  /**
   * Unpublish a template
   */
  async unpublish(templateId: string): Promise<GoalTemplateResponse> {
    const template = await this.prisma.goalTemplate.update({
      where: { id: templateId },
      data: { isPublished: false },
    });

    this.eventEmitter.emit('goal-template.unpublished', {
      templateId,
      tenantId: template.tenantId,
    });

    return this.toTemplateResponse(template);
  }

  /**
   * Delete a template
   */
  async delete(templateId: string): Promise<void> {
    const template = await this.prisma.goalTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    if (template.isBuiltIn) {
      throw new BadRequestException('Cannot delete built-in templates');
    }

    await this.prisma.goalTemplate.delete({
      where: { id: templateId },
    });

    this.eventEmitter.emit('goal-template.deleted', {
      templateId,
      tenantId: template.tenantId,
    });
  }

  /**
   * Create a goal run from a template
   */
  async createGoalRunFromTemplate(
    input: CreateFromTemplateInput,
  ): Promise<any> {
    const template = await this.prisma.goalTemplate.findUnique({
      where: { id: input.templateId },
    });

    if (!template) {
      throw new NotFoundException(`Template ${input.templateId} not found`);
    }

    // Validate required variables
    const variables = template.variables as unknown as TemplateVariable[];
    this.validateVariableValues(variables, input.variableValues);

    // Substitute variables in goal pattern
    const goal = this.substituteVariables(
      template.goalPattern,
      input.variableValues,
    );

    // Merge constraints
    const constraints: GoalConstraints = {
      ...(template.defaultConstraints as GoalConstraints),
      ...input.constraintOverrides,
    };

    // Create the goal run
    const goalRunInput: CreateGoalRunInput = {
      tenantId: input.tenantId,
      goal,
      constraints,
      autoStart: input.autoStart,
    };

    const goalRun = await this.goalRunService.createFromGoal(goalRunInput);

    // Track template usage
    await this.prisma.goalTemplate.update({
      where: { id: input.templateId },
      data: {
        usageCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });

    // Create junction record
    await this.prisma.goalRunFromTemplate.create({
      data: {
        goalRunId: goalRun.id,
        templateId: input.templateId,
        variableValues: input.variableValues as object,
      },
    });

    this.eventEmitter.emit('goal-template.used', {
      templateId: input.templateId,
      goalRunId: goalRun.id,
      tenantId: input.tenantId,
    });

    return {
      ...goalRun,
      template: {
        id: template.id,
        name: template.name,
        version: template.version,
      },
      variableValues: input.variableValues,
    };
  }

  /**
   * Preview template instantiation
   */
  async previewInstantiation(
    templateId: string,
    variableValues: Record<string, string | number | boolean>,
  ): Promise<{
    goal: string;
    checklist: { order: number; description: string; expectedOutcome?: string }[];
  }> {
    const template = await this.prisma.goalTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    const goal = this.substituteVariables(template.goalPattern, variableValues);

    const checklistTemplate = template.checklistTemplate as unknown as ChecklistTemplateItem[];
    const checklist = checklistTemplate.map((item) => ({
      order: item.order,
      description: this.substituteVariables(item.descriptionTemplate, variableValues),
      expectedOutcome: item.expectedOutcomeTemplate
        ? this.substituteVariables(item.expectedOutcomeTemplate, variableValues)
        : undefined,
    }));

    return { goal, checklist };
  }

  /**
   * Get template usage statistics
   */
  async getUsageStats(
    templateId: string,
  ): Promise<{
    totalUsage: number;
    last7Days: number;
    last30Days: number;
    successRate: number;
    avgDurationMs: number;
  }> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [template, recentUsage, monthUsage] = await Promise.all([
      this.prisma.goalTemplate.findUnique({ where: { id: templateId } }),
      this.prisma.goalRunFromTemplate.count({
        where: {
          templateId,
          createdAt: { gte: sevenDaysAgo },
        },
      }),
      this.prisma.goalRunFromTemplate.count({
        where: {
          templateId,
          createdAt: { gte: thirtyDaysAgo },
        },
      }),
    ]);

    if (!template) {
      throw new NotFoundException(`Template ${templateId} not found`);
    }

    // Get completion stats
    const goalRunIds = await this.prisma.goalRunFromTemplate.findMany({
      where: { templateId },
      select: { goalRunId: true },
    });

    const stats = await this.prisma.goalRun.aggregate({
      where: {
        id: { in: goalRunIds.map((g) => g.goalRunId) },
        status: 'COMPLETED',
      },
      _count: true,
      _avg: {
        currentPlanVersion: true,
      },
    });

    // Calculate average duration from completed goal runs with both timestamps
    const completedRuns = await this.prisma.goalRun.findMany({
      where: {
        id: { in: goalRunIds.map((g) => g.goalRunId) },
        status: 'COMPLETED',
        startedAt: { not: null },
        completedAt: { not: null },
      },
      select: {
        startedAt: true,
        completedAt: true,
      },
    });

    let avgDurationMs = 0;
    if (completedRuns.length > 0) {
      const totalDurationMs = completedRuns.reduce((sum, run) => {
        if (run.startedAt && run.completedAt) {
          return sum + (run.completedAt.getTime() - run.startedAt.getTime());
        }
        return sum;
      }, 0);
      avgDurationMs = Math.round(totalDurationMs / completedRuns.length);
    }

    const completedCount = stats._count || 0;
    const totalCount = goalRunIds.length;

    return {
      totalUsage: template.usageCount,
      last7Days: recentUsage,
      last30Days: monthUsage,
      successRate: totalCount > 0 ? (completedCount / totalCount) * 100 : 0,
      avgDurationMs,
    };
  }

  // Helper methods

  private validateGoalPattern(pattern: string, variables: TemplateVariable[]): void {
    // Find all variables in pattern
    const patternVars = pattern.match(/\{\{(\w+)\}\}/g) || [];
    const patternVarNames = patternVars.map((v) => v.replace(/\{\{|\}\}/g, ''));

    // Check all pattern variables are defined
    const definedVarNames = variables.map((v) => v.name);
    for (const varName of patternVarNames) {
      if (!definedVarNames.includes(varName)) {
        throw new BadRequestException(
          `Variable "{{${varName}}}" used in pattern but not defined`,
        );
      }
    }
  }

  private validateVariableValues(
    variables: TemplateVariable[],
    values: Record<string, string | number | boolean>,
  ): void {
    for (const variable of variables) {
      const value = values[variable.name];

      if (variable.required && (value === undefined || value === null || value === '')) {
        throw new BadRequestException(`Required variable "${variable.name}" is missing`);
      }

      if (value !== undefined && value !== null) {
        // Type validation
        const actualType = typeof value;
        if (variable.type === 'number' && actualType !== 'number') {
          throw new BadRequestException(
            `Variable "${variable.name}" must be a number`,
          );
        }
        if (variable.type === 'boolean' && actualType !== 'boolean') {
          throw new BadRequestException(
            `Variable "${variable.name}" must be a boolean`,
          );
        }
        if (variable.type === 'select' && variable.options) {
          if (!variable.options.includes(String(value))) {
            throw new BadRequestException(
              `Variable "${variable.name}" must be one of: ${variable.options.join(', ')}`,
            );
          }
        }

        // Validation rules
        if (variable.validation) {
          const v = variable.validation;
          if (typeof value === 'string') {
            if (v.minLength && value.length < v.minLength) {
              throw new BadRequestException(
                `Variable "${variable.name}" must be at least ${v.minLength} characters`,
              );
            }
            if (v.maxLength && value.length > v.maxLength) {
              throw new BadRequestException(
                `Variable "${variable.name}" must be at most ${v.maxLength} characters`,
              );
            }
            if (v.pattern && !new RegExp(v.pattern).test(value)) {
              throw new BadRequestException(
                `Variable "${variable.name}" does not match required pattern`,
              );
            }
          }
          if (typeof value === 'number') {
            if (v.min !== undefined && value < v.min) {
              throw new BadRequestException(
                `Variable "${variable.name}" must be at least ${v.min}`,
              );
            }
            if (v.max !== undefined && value > v.max) {
              throw new BadRequestException(
                `Variable "${variable.name}" must be at most ${v.max}`,
              );
            }
          }
        }
      }
    }
  }

  private substituteVariables(
    template: string,
    values: Record<string, string | number | boolean>,
  ): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      const value = values[varName];
      return value !== undefined ? String(value) : match;
    });
  }

  private toTemplateResponse(template: any): GoalTemplateResponse {
    return {
      id: template.id,
      tenantId: template.tenantId,
      name: template.name,
      description: template.description,
      category: template.category,
      tags: template.tags,
      icon: template.icon,
      goalPattern: template.goalPattern,
      defaultConstraints: template.defaultConstraints as GoalConstraints,
      variables: template.variables as TemplateVariable[],
      checklistTemplate: template.checklistTemplate as ChecklistTemplateItem[],
      version: template.version,
      isLatest: template.isLatest,
      isPublished: template.isPublished,
      isBuiltIn: template.isBuiltIn,
      usageCount: template.usageCount,
      lastUsedAt: template.lastUsedAt,
      createdBy: template.createdBy,
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    };
  }
}
