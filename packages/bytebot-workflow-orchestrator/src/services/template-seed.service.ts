/**
 * Template Seed Service
 * Phase 7: Enhanced Features
 *
 * Seeds built-in goal templates during application startup.
 * Built-in templates provide common automation patterns that users can
 * customize and use immediately.
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { createId } from '@paralleldrive/cuid2';

// Built-in template tenant ID (system-wide templates)
const BUILTIN_TENANT_ID = '__builtin__';

interface BuiltInTemplate {
  name: string;
  description: string;
  category: string;
  tags: string[];
  icon: string;
  goalPattern: string;
  variables: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'select';
    required: boolean;
    default?: string | number | boolean;
    description: string;
    options?: string[];
    validation?: {
      minLength?: number;
      maxLength?: number;
      pattern?: string;
    };
  }>;
  checklistTemplate: Array<{
    order: number;
    descriptionTemplate: string;
    expectedOutcomeTemplate?: string;
    suggestedTools?: string[];
    requiresDesktop?: boolean;
  }>;
}

@Injectable()
export class TemplateSeedService implements OnModuleInit {
  private readonly logger = new Logger(TemplateSeedService.name);

  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    await this.seedBuiltInTemplates();
  }

  /**
   * Seed built-in templates if they don't exist
   */
  async seedBuiltInTemplates(): Promise<void> {
    this.logger.log('Checking for built-in templates...');

    const existingCount = await this.prisma.goalTemplate.count({
      where: { isBuiltIn: true },
    });

    if (existingCount > 0) {
      this.logger.log(`Found ${existingCount} existing built-in templates, skipping seed`);
      return;
    }

    this.logger.log('Seeding built-in templates...');

    const templates = this.getBuiltInTemplates();
    let seeded = 0;

    for (const template of templates) {
      try {
        await this.prisma.goalTemplate.create({
          data: {
            id: createId(),
            tenantId: BUILTIN_TENANT_ID,
            name: template.name,
            description: template.description,
            category: template.category,
            tags: template.tags,
            icon: template.icon,
            goalPattern: template.goalPattern,
            defaultConstraints: {},
            variables: template.variables as any,
            checklistTemplate: template.checklistTemplate as any,
            version: '1.0.0',
            isLatest: true,
            isPublished: true,
            isBuiltIn: true,
            usageCount: 0,
            createdBy: 'system',
          },
        });
        seeded++;
        this.logger.debug(`Seeded template: ${template.name}`);
      } catch (error: any) {
        this.logger.warn(`Failed to seed template "${template.name}": ${error.message}`);
      }
    }

    this.logger.log(`Seeded ${seeded} built-in templates`);
  }

  /**
   * Get list of built-in templates
   */
  private getBuiltInTemplates(): BuiltInTemplate[] {
    return [
      // Web Research Template
      {
        name: 'Web Research',
        description: 'Research a topic online and compile findings into a structured summary',
        category: 'Research',
        tags: ['research', 'web', 'summary', 'information'],
        icon: 'search',
        goalPattern: 'Research {{topic}} and compile a summary including {{aspects}}',
        variables: [
          {
            name: 'topic',
            type: 'string',
            required: true,
            description: 'The topic or subject to research',
            validation: { minLength: 3, maxLength: 200 },
          },
          {
            name: 'aspects',
            type: 'string',
            required: true,
            default: 'key facts, recent developments, and notable sources',
            description: 'Specific aspects to cover in the research',
          },
        ],
        checklistTemplate: [
          {
            order: 1,
            descriptionTemplate: 'Open a web browser and search for "{{topic}}"',
            expectedOutcomeTemplate: 'Search results page displayed with relevant results',
            suggestedTools: ['browser'],
            requiresDesktop: true,
          },
          {
            order: 2,
            descriptionTemplate: 'Visit and read the top 3-5 most relevant sources',
            expectedOutcomeTemplate: 'Key information gathered from multiple sources',
            requiresDesktop: true,
          },
          {
            order: 3,
            descriptionTemplate: 'Compile findings into a structured summary covering {{aspects}}',
            expectedOutcomeTemplate: 'Summary document created with organized information',
            requiresDesktop: true,
          },
        ],
      },

      // Form Submission Template
      {
        name: 'Form Submission',
        description: 'Fill out and submit a web form with provided data',
        category: 'Data Entry',
        tags: ['form', 'submit', 'data-entry', 'automation'],
        icon: 'edit-3',
        goalPattern: 'Navigate to {{url}} and fill out the form with the following data: {{formData}}',
        variables: [
          {
            name: 'url',
            type: 'string',
            required: true,
            description: 'The URL of the form to fill out',
            validation: { pattern: '^https?://.+' },
          },
          {
            name: 'formData',
            type: 'string',
            required: true,
            description: 'The data to enter (field: value pairs)',
          },
        ],
        checklistTemplate: [
          {
            order: 1,
            descriptionTemplate: 'Navigate to {{url}}',
            expectedOutcomeTemplate: 'Form page loaded successfully',
            requiresDesktop: true,
          },
          {
            order: 2,
            descriptionTemplate: 'Locate and fill in form fields with provided data: {{formData}}',
            expectedOutcomeTemplate: 'All form fields populated with correct values',
            requiresDesktop: true,
          },
          {
            order: 3,
            descriptionTemplate: 'Submit the form',
            expectedOutcomeTemplate: 'Form submitted successfully with confirmation',
            requiresDesktop: true,
          },
        ],
      },

      // Data Extraction Template
      {
        name: 'Data Extraction',
        description: 'Extract specific data from a webpage and save it',
        category: 'Data Collection',
        tags: ['scraping', 'extraction', 'data', 'web'],
        icon: 'download',
        goalPattern: 'Extract {{dataType}} from {{url}} and save to {{outputFormat}}',
        variables: [
          {
            name: 'url',
            type: 'string',
            required: true,
            description: 'The URL to extract data from',
            validation: { pattern: '^https?://.+' },
          },
          {
            name: 'dataType',
            type: 'string',
            required: true,
            description: 'Type of data to extract (e.g., prices, contact info, product details)',
          },
          {
            name: 'outputFormat',
            type: 'select',
            required: true,
            default: 'text file',
            description: 'Format for the extracted data',
            options: ['text file', 'CSV', 'JSON', 'clipboard'],
          },
        ],
        checklistTemplate: [
          {
            order: 1,
            descriptionTemplate: 'Navigate to {{url}}',
            expectedOutcomeTemplate: 'Page loaded with target data visible',
            requiresDesktop: true,
          },
          {
            order: 2,
            descriptionTemplate: 'Identify and extract {{dataType}} from the page',
            expectedOutcomeTemplate: 'Target data identified and captured',
            requiresDesktop: true,
          },
          {
            order: 3,
            descriptionTemplate: 'Format and save extracted data as {{outputFormat}}',
            expectedOutcomeTemplate: 'Data saved in requested format',
            requiresDesktop: true,
          },
        ],
      },

      // Screenshot Capture Template
      {
        name: 'Screenshot Capture',
        description: 'Navigate to a webpage and capture screenshots',
        category: 'Documentation',
        tags: ['screenshot', 'capture', 'documentation', 'visual'],
        icon: 'camera',
        goalPattern: 'Take {{screenshotType}} screenshot(s) of {{url}}',
        variables: [
          {
            name: 'url',
            type: 'string',
            required: true,
            description: 'The URL to screenshot',
            validation: { pattern: '^https?://.+' },
          },
          {
            name: 'screenshotType',
            type: 'select',
            required: true,
            default: 'full page',
            description: 'Type of screenshot to capture',
            options: ['full page', 'viewport only', 'specific element'],
          },
        ],
        checklistTemplate: [
          {
            order: 1,
            descriptionTemplate: 'Navigate to {{url}}',
            expectedOutcomeTemplate: 'Page fully loaded and rendered',
            requiresDesktop: true,
          },
          {
            order: 2,
            descriptionTemplate: 'Wait for any dynamic content to load',
            expectedOutcomeTemplate: 'All content visible and stable',
            requiresDesktop: true,
          },
          {
            order: 3,
            descriptionTemplate: 'Capture {{screenshotType}} screenshot',
            expectedOutcomeTemplate: 'Screenshot captured and saved',
            requiresDesktop: true,
          },
        ],
      },

      // Email Composition Template
      {
        name: 'Email Composition',
        description: 'Compose and send an email via webmail',
        category: 'Communication',
        tags: ['email', 'communication', 'compose', 'send'],
        icon: 'mail',
        goalPattern: 'Compose and send an email to {{recipient}} about {{subject}}',
        variables: [
          {
            name: 'recipient',
            type: 'string',
            required: true,
            description: 'Email recipient address',
            validation: { pattern: '^[^@]+@[^@]+\\.[^@]+$' },
          },
          {
            name: 'subject',
            type: 'string',
            required: true,
            description: 'Email subject line',
            validation: { minLength: 1, maxLength: 200 },
          },
          {
            name: 'emailBody',
            type: 'string',
            required: true,
            description: 'The content of the email',
          },
          {
            name: 'webmailProvider',
            type: 'select',
            required: true,
            default: 'Gmail',
            description: 'Webmail provider to use',
            options: ['Gmail', 'Outlook', 'Yahoo Mail'],
          },
        ],
        checklistTemplate: [
          {
            order: 1,
            descriptionTemplate: 'Open {{webmailProvider}} in the browser',
            expectedOutcomeTemplate: 'Webmail interface loaded (login if needed)',
            requiresDesktop: true,
          },
          {
            order: 2,
            descriptionTemplate: 'Click compose/new email button',
            expectedOutcomeTemplate: 'New email composition window open',
            requiresDesktop: true,
          },
          {
            order: 3,
            descriptionTemplate: 'Enter recipient: {{recipient}}, subject: {{subject}}',
            expectedOutcomeTemplate: 'To and Subject fields populated',
            requiresDesktop: true,
          },
          {
            order: 4,
            descriptionTemplate: 'Enter email body content',
            expectedOutcomeTemplate: 'Email body composed with provided content',
            requiresDesktop: true,
          },
          {
            order: 5,
            descriptionTemplate: 'Review and send the email',
            expectedOutcomeTemplate: 'Email sent successfully',
            requiresDesktop: true,
          },
        ],
      },

      // Price Comparison Template
      {
        name: 'Price Comparison',
        description: 'Compare prices for a product across multiple websites',
        category: 'Shopping',
        tags: ['price', 'comparison', 'shopping', 'research'],
        icon: 'dollar-sign',
        goalPattern: 'Compare prices for {{product}} across {{sites}}',
        variables: [
          {
            name: 'product',
            type: 'string',
            required: true,
            description: 'Product name or description to search for',
            validation: { minLength: 2, maxLength: 200 },
          },
          {
            name: 'sites',
            type: 'string',
            required: true,
            default: 'Amazon, eBay, Walmart',
            description: 'Comma-separated list of sites to check',
          },
        ],
        checklistTemplate: [
          {
            order: 1,
            descriptionTemplate: 'Search for "{{product}}" on each site: {{sites}}',
            expectedOutcomeTemplate: 'Search results displayed on each site',
            requiresDesktop: true,
          },
          {
            order: 2,
            descriptionTemplate: 'Record the price, shipping cost, and availability from each site',
            expectedOutcomeTemplate: 'Price data collected from all sites',
            requiresDesktop: true,
          },
          {
            order: 3,
            descriptionTemplate: 'Compile comparison summary with best deal recommendation',
            expectedOutcomeTemplate: 'Comparison table created with recommendation',
            requiresDesktop: true,
          },
        ],
      },

      // Social Media Post Template
      {
        name: 'Social Media Post',
        description: 'Create and publish a post on social media',
        category: 'Social Media',
        tags: ['social', 'post', 'marketing', 'content'],
        icon: 'share-2',
        goalPattern: 'Post "{{content}}" to {{platform}}',
        variables: [
          {
            name: 'platform',
            type: 'select',
            required: true,
            default: 'Twitter/X',
            description: 'Social media platform to post on',
            options: ['Twitter/X', 'LinkedIn', 'Facebook'],
          },
          {
            name: 'content',
            type: 'string',
            required: true,
            description: 'The content to post',
            validation: { minLength: 1, maxLength: 2000 },
          },
          {
            name: 'includeImage',
            type: 'boolean',
            required: false,
            default: false,
            description: 'Whether to include an image with the post',
          },
        ],
        checklistTemplate: [
          {
            order: 1,
            descriptionTemplate: 'Navigate to {{platform}} and ensure logged in',
            expectedOutcomeTemplate: 'Social media platform loaded and authenticated',
            requiresDesktop: true,
          },
          {
            order: 2,
            descriptionTemplate: 'Create new post with content: {{content}}',
            expectedOutcomeTemplate: 'Post content entered in composition area',
            requiresDesktop: true,
          },
          {
            order: 3,
            descriptionTemplate: 'Review and publish the post',
            expectedOutcomeTemplate: 'Post published successfully and visible on timeline',
            requiresDesktop: true,
          },
        ],
      },

      // PDF Download Template
      {
        name: 'PDF Download',
        description: 'Download a PDF from a webpage',
        category: 'File Operations',
        tags: ['download', 'pdf', 'document', 'file'],
        icon: 'file-text',
        goalPattern: 'Download PDF from {{url}} and save as {{filename}}',
        variables: [
          {
            name: 'url',
            type: 'string',
            required: true,
            description: 'URL of the page containing the PDF or direct PDF link',
            validation: { pattern: '^https?://.+' },
          },
          {
            name: 'filename',
            type: 'string',
            required: false,
            default: 'downloaded.pdf',
            description: 'Name to save the file as',
          },
        ],
        checklistTemplate: [
          {
            order: 1,
            descriptionTemplate: 'Navigate to {{url}}',
            expectedOutcomeTemplate: 'Page loaded with PDF link or content visible',
            requiresDesktop: true,
          },
          {
            order: 2,
            descriptionTemplate: 'Locate and click the PDF download link',
            expectedOutcomeTemplate: 'PDF download initiated',
            requiresDesktop: true,
          },
          {
            order: 3,
            descriptionTemplate: 'Save the file as {{filename}}',
            expectedOutcomeTemplate: 'PDF saved to downloads folder',
            requiresDesktop: true,
          },
        ],
      },
    ];
  }
}
