/**
 * Goal Template Controller
 * Phase 7: Enhanced Features
 *
 * REST API endpoints for goal template management:
 * - CRUD operations for templates
 * - Template instantiation
 * - Template versioning
 * - Usage statistics
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  IsString,
  IsOptional,
  IsBoolean,
  IsObject,
  IsArray,
  IsEnum,
  IsNumber,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiHeader,
  ApiProperty,
} from '@nestjs/swagger';
import {
  GoalTemplateService,
  CreateGoalTemplateInput,
  UpdateGoalTemplateInput,
  GoalTemplateFilters,
  CreateFromTemplateInput,
} from '../services/goal-template.service';

// ============================================================================
// DTOs with class-validator decorators for ValidationPipe compatibility
// ============================================================================

enum VariableType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  SELECT = 'select',
}

class TemplateVariableDto {
  @ApiProperty({ description: 'Variable name (used in {{name}} syntax)', example: 'repository_url' })
  @IsString()
  name!: string;

  @ApiProperty({ enum: ['string', 'number', 'boolean', 'select'], description: 'Variable type' })
  @IsEnum(VariableType)
  type!: VariableType;

  @ApiProperty({ description: 'Whether the variable is required' })
  @IsBoolean()
  required!: boolean;

  @ApiProperty({ required: false, description: 'Default value for the variable' })
  @IsOptional()
  default?: string | number | boolean;

  @ApiProperty({ required: false, description: 'Variable description/help text' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, type: [String], description: 'Options for select type' })
  @IsOptional()
  @IsArray()
  options?: string[];

  @ApiProperty({ required: false, description: 'Validation rules' })
  @IsOptional()
  @IsObject()
  validation?: {
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    pattern?: string;
  };
}

class ChecklistTemplateItemDto {
  @ApiProperty({ description: 'Item order in checklist' })
  @IsNumber()
  order!: number;

  @ApiProperty({ description: 'Description template with {{variables}}' })
  @IsString()
  descriptionTemplate!: string;

  @ApiProperty({ required: false, description: 'Expected outcome template' })
  @IsOptional()
  @IsString()
  expectedOutcomeTemplate?: string;

  @ApiProperty({ required: false, type: [String], description: 'Suggested tools for this step' })
  @IsOptional()
  @IsArray()
  suggestedTools?: string[];

  @ApiProperty({ required: false, description: 'Whether step requires desktop access' })
  @IsOptional()
  @IsBoolean()
  requiresDesktop?: boolean;
}

class CreateTemplateDto {
  @ApiProperty({ description: 'Template name', example: 'Deploy to Production', minLength: 3 })
  @IsString()
  @MinLength(3)
  name!: string;

  @ApiProperty({ required: false, description: 'Template description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, description: 'Category for organization', example: 'deployment' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ required: false, type: [String], description: 'Tags for filtering', example: ['kubernetes', 'production'] })
  @IsOptional()
  @IsArray()
  tags?: string[];

  @ApiProperty({ required: false, description: 'Icon identifier', example: 'rocket' })
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiProperty({
    description: 'Goal pattern with {{variable}} placeholders',
    example: 'Deploy {{service_name}} to {{environment}} using {{deploy_strategy}} strategy',
    minLength: 10,
  })
  @IsString()
  @MinLength(10)
  goalPattern!: string;

  @ApiProperty({ required: false, description: 'Default constraints for goal execution' })
  @IsOptional()
  @IsObject()
  defaultConstraints?: Record<string, unknown>;

  @ApiProperty({ required: false, type: [TemplateVariableDto], description: 'Variable definitions' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateVariableDto)
  variables?: TemplateVariableDto[];

  @ApiProperty({ required: false, type: [ChecklistTemplateItemDto], description: 'Checklist template for progress tracking' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChecklistTemplateItemDto)
  checklistTemplate?: ChecklistTemplateItemDto[];
}

class UpdateTemplateDto {
  @ApiProperty({ required: false, description: 'Template name', minLength: 3 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  name?: string;

  @ApiProperty({ required: false, description: 'Template description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false, description: 'Category for organization' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ required: false, type: [String], description: 'Tags for filtering' })
  @IsOptional()
  @IsArray()
  tags?: string[];

  @ApiProperty({ required: false, description: 'Icon identifier' })
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiProperty({ required: false, description: 'Goal pattern with {{variable}} placeholders' })
  @IsOptional()
  @IsString()
  goalPattern?: string;

  @ApiProperty({ required: false, description: 'Default constraints for goal execution' })
  @IsOptional()
  @IsObject()
  defaultConstraints?: Record<string, unknown>;

  @ApiProperty({ required: false, type: [TemplateVariableDto], description: 'Variable definitions' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TemplateVariableDto)
  variables?: TemplateVariableDto[];

  @ApiProperty({ required: false, type: [ChecklistTemplateItemDto], description: 'Checklist template' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChecklistTemplateItemDto)
  checklistTemplate?: ChecklistTemplateItemDto[];
}

class CreateFromTemplateDto {
  @ApiProperty({
    description: 'Values for template variables',
    example: { service_name: 'api-gateway', environment: 'production', deploy_strategy: 'rolling' },
  })
  @IsObject()
  variableValues!: Record<string, string | number | boolean>;

  @ApiProperty({ required: false, description: 'Override default constraints' })
  @IsOptional()
  @IsObject()
  constraintOverrides?: Record<string, unknown>;

  @ApiProperty({ required: false, description: 'Auto-start goal run after creation', default: false })
  @IsOptional()
  @IsBoolean()
  autoStart?: boolean;
}

class PreviewInstantiationDto {
  @ApiProperty({
    description: 'Values for template variables to preview',
    example: { service_name: 'api-gateway', environment: 'staging' },
  })
  @IsObject()
  variableValues!: Record<string, string | number | boolean>;
}

class TemplateFiltersDto {
  @ApiProperty({ required: false, description: 'Filter by category' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiProperty({ required: false, description: 'Filter by tags (comma-separated)' })
  @IsOptional()
  @IsString()
  tags?: string;

  @ApiProperty({ required: false, description: 'Filter by published status' })
  @IsOptional()
  @IsString()
  isPublished?: string;

  @ApiProperty({ required: false, description: 'Filter by built-in status' })
  @IsOptional()
  @IsString()
  isBuiltIn?: string;

  @ApiProperty({ required: false, description: 'Search in name and description' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({ required: false, description: 'Page number', default: '1' })
  @IsOptional()
  @IsString()
  page?: string;

  @ApiProperty({ required: false, description: 'Page size', default: '20' })
  @IsOptional()
  @IsString()
  pageSize?: string;
}

@ApiTags('templates')
// v5.11.3: Removed deprecated api/v1/templates backward compatibility prefix (was scheduled for v5.6.0)
@Controller('templates')
export class TemplateController {
  constructor(private templateService: GoalTemplateService) {}

  /**
   * POST /api/v1/templates
   * Create a new goal template
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new goal template',
    description: 'Creates a reusable goal template with variable placeholders for parameterization.',
  })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiHeader({ name: 'x-user-id', description: 'User identifier (optional)', required: false })
  @ApiResponse({ status: 201, description: 'Template created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  async createTemplate(
    @Body() dto: CreateTemplateDto,
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-user-id') userId?: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    if (!dto.name || dto.name.trim().length < 3) {
      throw new BadRequestException('Template name must be at least 3 characters');
    }

    if (!dto.goalPattern || dto.goalPattern.trim().length < 10) {
      throw new BadRequestException('Goal pattern must be at least 10 characters');
    }

    const input: CreateGoalTemplateInput = {
      tenantId,
      name: dto.name.trim(),
      description: dto.description,
      category: dto.category,
      tags: dto.tags,
      icon: dto.icon,
      goalPattern: dto.goalPattern,
      defaultConstraints: dto.defaultConstraints,
      variables: dto.variables,
      checklistTemplate: dto.checklistTemplate,
      createdBy: userId,
    };

    const template = await this.templateService.create(input);

    return {
      success: true,
      data: template,
    };
  }

  /**
   * GET /api/v1/templates
   * List templates for tenant
   */
  @Get()
  @ApiOperation({
    summary: 'List goal templates',
    description: 'Returns paginated list of goal templates for the tenant with optional filtering.',
  })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiResponse({ status: 200, description: 'Templates retrieved successfully' })
  async listTemplates(
    @Query() query: TemplateFiltersDto,
    @Headers('x-tenant-id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const filters: GoalTemplateFilters = {
      category: query.category,
      tags: query.tags ? query.tags.split(',') : undefined,
      isPublished: query.isPublished === 'true' ? true : query.isPublished === 'false' ? false : undefined,
      isBuiltIn: query.isBuiltIn === 'true' ? true : query.isBuiltIn === 'false' ? false : undefined,
      search: query.search,
      page: query.page ? parseInt(query.page, 10) : 1,
      pageSize: query.pageSize ? parseInt(query.pageSize, 10) : 20,
    };

    const result = await this.templateService.findByTenant(tenantId, filters);

    return {
      success: true,
      ...result,
    };
  }

  /**
   * GET /api/v1/templates/categories
   * Get all template categories
   */
  @Get('categories')
  @ApiOperation({ summary: 'Get template categories', description: 'Returns all unique categories for organizing templates.' })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiResponse({ status: 200, description: 'Categories retrieved successfully' })
  async getCategories(@Headers('x-tenant-id') tenantId?: string) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    const categories = await this.templateService.getCategories(tenantId);

    return {
      success: true,
      data: categories,
    };
  }

  /**
   * GET /api/v1/templates/:id
   * Get template by ID
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get template by ID', description: 'Returns a specific goal template with all its details.' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 200, description: 'Template retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async getTemplate(@Param('id') id: string) {
    const template = await this.templateService.findById(id);

    return {
      success: true,
      data: template,
    };
  }

  /**
   * PUT /api/v1/templates/:id
   * Update template
   */
  @Put(':id')
  @ApiOperation({ summary: 'Update template', description: 'Updates an existing goal template. Creates a new version if structural changes are made.' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 200, description: 'Template updated successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async updateTemplate(
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    const input: UpdateGoalTemplateInput = {
      name: dto.name,
      description: dto.description,
      category: dto.category,
      tags: dto.tags,
      icon: dto.icon,
      goalPattern: dto.goalPattern,
      defaultConstraints: dto.defaultConstraints,
      variables: dto.variables,
      checklistTemplate: dto.checklistTemplate,
    };

    const template = await this.templateService.update(id, input);

    return {
      success: true,
      data: template,
    };
  }

  /**
   * POST /api/v1/templates/:id/version
   * Create new version of template
   */
  @Post(':id/version')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create new template version', description: 'Creates a new version of the template while preserving the original.' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 201, description: 'New version created successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async createNewVersion(
    @Param('id') id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    const input: UpdateGoalTemplateInput = {
      name: dto.name,
      description: dto.description,
      category: dto.category,
      tags: dto.tags,
      icon: dto.icon,
      goalPattern: dto.goalPattern,
      defaultConstraints: dto.defaultConstraints,
      variables: dto.variables,
      checklistTemplate: dto.checklistTemplate,
    };

    const template = await this.templateService.createNewVersion(id, input);

    return {
      success: true,
      data: template,
    };
  }

  /**
   * POST /api/v1/templates/:id/publish
   * Publish template
   */
  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish template', description: 'Makes the template available for use by other users in the tenant.' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 200, description: 'Template published successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async publishTemplate(@Param('id') id: string) {
    const template = await this.templateService.publish(id);

    return {
      success: true,
      data: template,
    };
  }

  /**
   * POST /api/v1/templates/:id/unpublish
   * Unpublish template
   */
  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unpublish template', description: 'Removes the template from public availability.' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 200, description: 'Template unpublished successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async unpublishTemplate(@Param('id') id: string) {
    const template = await this.templateService.unpublish(id);

    return {
      success: true,
      data: template,
    };
  }

  /**
   * DELETE /api/v1/templates/:id
   * Delete template
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete template', description: 'Permanently deletes a goal template.' })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 204, description: 'Template deleted successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async deleteTemplate(@Param('id') id: string) {
    await this.templateService.delete(id);
  }

  /**
   * POST /api/v1/templates/:id/instantiate
   * Create goal run from template
   * Rate limited: 5 per minute (expensive operation)
   */
  @Post(':id/instantiate')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({
    summary: 'Instantiate template',
    description: 'Creates a new goal run from the template with the provided variable values. Rate limited to 5 requests per minute.',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiHeader({ name: 'x-tenant-id', description: 'Tenant identifier', required: true })
  @ApiResponse({ status: 201, description: 'Goal run created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid variable values or missing required variables' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded' })
  async instantiateTemplate(
    @Param('id') id: string,
    @Body() dto: CreateFromTemplateDto,
    @Headers('x-tenant-id') tenantId?: string,
  ) {
    if (!tenantId) {
      throw new BadRequestException('x-tenant-id header is required');
    }

    if (!dto.variableValues) {
      throw new BadRequestException('variableValues is required');
    }

    const input: CreateFromTemplateInput = {
      tenantId,
      templateId: id,
      variableValues: dto.variableValues,
      constraintOverrides: dto.constraintOverrides,
      autoStart: dto.autoStart,
    };

    const goalRun = await this.templateService.createGoalRunFromTemplate(input);

    return {
      success: true,
      data: goalRun,
    };
  }

  /**
   * POST /api/v1/templates/:id/preview
   * Preview template instantiation
   */
  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview template instantiation',
    description: 'Returns a preview of what the goal text would look like with the provided variable values without creating a goal run.',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 200, description: 'Preview generated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid variable values' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async previewInstantiation(
    @Param('id') id: string,
    @Body() dto: PreviewInstantiationDto,
  ) {
    if (!dto.variableValues) {
      throw new BadRequestException('variableValues is required');
    }

    const preview = await this.templateService.previewInstantiation(
      id,
      dto.variableValues,
    );

    return {
      success: true,
      data: preview,
    };
  }

  /**
   * GET /api/v1/templates/:id/stats
   * Get template usage statistics
   */
  @Get(':id/stats')
  @ApiOperation({
    summary: 'Get template statistics',
    description: 'Returns usage statistics for the template including execution counts, success rates, and recent runs.',
  })
  @ApiParam({ name: 'id', description: 'Template ID' })
  @ApiResponse({ status: 200, description: 'Statistics retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async getTemplateStats(@Param('id') id: string) {
    const stats = await this.templateService.getUsageStats(id);

    return {
      success: true,
      data: stats,
    };
  }
}
