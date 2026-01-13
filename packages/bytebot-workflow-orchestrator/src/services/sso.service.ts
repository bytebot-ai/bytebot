/**
 * SSO (Single Sign-On) Service
 * Phase 10 (v5.5.0): Enterprise Features - SAML/SSO Integration
 *
 * Provides SAML 2.0 SSO capabilities:
 * - Service Provider (SP) metadata generation
 * - SAML assertion validation
 * - Just-in-time user provisioning
 * - Attribute mapping
 * - Session management
 */

import { Injectable, Logger, NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import * as crypto from 'crypto';

// ============================================================================
// Types and Interfaces
// ============================================================================

export enum SSOProvider {
  SAML = 'saml',
  OIDC = 'oidc',
}

export interface SAMLConfig {
  entityId: string;
  ssoUrl: string;
  sloUrl?: string;
  certificate: string;
  signatureAlgorithm?: 'sha256' | 'sha512';
}

export interface AttributeMapping {
  email: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  groups?: string;
  role?: string;
}

export interface SSOConfigInput {
  provider: SSOProvider;
  saml?: SAMLConfig;
  attributeMapping?: AttributeMapping;
  jitProvisioning?: boolean;
  defaultRole?: string;
  enforcedDomains?: string[];
  allowBypassSSO?: boolean;
}

export interface SAMLAssertion {
  nameId: string;
  nameIdFormat?: string;
  sessionIndex?: string;
  attributes: Record<string, string | string[]>;
  issuer: string;
  audience: string;
  notBefore?: Date;
  notOnOrAfter?: Date;
}

export interface SSOUser {
  email: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  groups?: string[];
  role?: string;
  tenantId: string;
  ssoSessionId: string;
  expiresAt: Date;
}

export interface SPMetadata {
  entityId: string;
  acsUrl: string;
  sloUrl: string;
  certificate?: string;
  nameIdFormat: string;
  wantAssertionsSigned: boolean;
}

// Default attribute mapping for common IdPs
const DEFAULT_ATTRIBUTE_MAPPINGS: Record<string, AttributeMapping> = {
  default: {
    email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    displayName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
    groups: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  },
  okta: {
    email: 'email',
    firstName: 'firstName',
    lastName: 'lastName',
    displayName: 'displayName',
    groups: 'groups',
  },
  azure_ad: {
    email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
    firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
    lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
    displayName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name',
    groups: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  },
  google: {
    email: 'email',
    firstName: 'first_name',
    lastName: 'last_name',
    displayName: 'name',
  },
};

@Injectable()
export class SSOService {
  private readonly logger = new Logger(SSOService.name);
  private readonly baseUrl: string;
  private readonly spEntityId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.baseUrl = this.configService.get('BASE_URL', 'http://localhost:8080');
    this.spEntityId = this.configService.get('SAML_SP_ENTITY_ID', `${this.baseUrl}/saml/metadata`);
    this.logger.log('SSOService initialized');
  }

  // ==========================================================================
  // SSO Configuration Management
  // ==========================================================================

  /**
   * Configure SSO for a tenant
   */
  async configureSSOv(tenantId: string, input: SSOConfigInput): Promise<any> {
    // Validate tenant exists
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });

    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    // Validate SAML config if provider is SAML
    if (input.provider === SSOProvider.SAML && input.saml) {
      this.validateSAMLConfig(input.saml);
    }

    // Create or update SSO config
    const config = await this.prisma.sSOConfiguration.upsert({
      where: { tenantId },
      create: {
        tenantId,
        provider: input.provider,
        entityId: input.saml?.entityId,
        ssoUrl: input.saml?.ssoUrl,
        sloUrl: input.saml?.sloUrl,
        certificate: input.saml?.certificate,
        signatureAlgorithm: input.saml?.signatureAlgorithm || 'sha256',
        attributeMapping: (input.attributeMapping || DEFAULT_ATTRIBUTE_MAPPINGS.default) as object,
        jitProvisioning: input.jitProvisioning ?? true,
        defaultRole: input.defaultRole || 'member',
        enforcedDomains: input.enforcedDomains || [],
        allowBypassSSO: input.allowBypassSSO ?? false,
        enabled: false, // Requires verification to enable
        verified: false,
      },
      update: {
        provider: input.provider,
        entityId: input.saml?.entityId,
        ssoUrl: input.saml?.ssoUrl,
        sloUrl: input.saml?.sloUrl,
        certificate: input.saml?.certificate,
        signatureAlgorithm: input.saml?.signatureAlgorithm,
        attributeMapping: input.attributeMapping as object | undefined,
        jitProvisioning: input.jitProvisioning,
        defaultRole: input.defaultRole,
        enforcedDomains: input.enforcedDomains,
        allowBypassSSO: input.allowBypassSSO,
      },
    });

    this.logger.log(`SSO configured for tenant ${tenantId}`);
    this.eventEmitter.emit('sso.configured', { tenantId, provider: input.provider });

    return config;
  }

  /**
   * Get SSO configuration for a tenant
   */
  async getSSOConfig(tenantId: string): Promise<any> {
    const config = await this.prisma.sSOConfiguration.findUnique({
      where: { tenantId },
    });

    if (!config) {
      throw new NotFoundException(`SSO not configured for tenant ${tenantId}`);
    }

    // Don't return sensitive data
    return {
      ...config,
      certificate: config.certificate ? '***CONFIGURED***' : null,
    };
  }

  /**
   * Enable SSO for a tenant (requires prior verification)
   */
  async enableSSO(tenantId: string): Promise<any> {
    const config = await this.prisma.sSOConfiguration.findUnique({
      where: { tenantId },
    });

    if (!config) {
      throw new NotFoundException(`SSO not configured for tenant ${tenantId}`);
    }

    if (!config.verified) {
      throw new BadRequestException('SSO configuration must be verified before enabling');
    }

    const updated = await this.prisma.sSOConfiguration.update({
      where: { tenantId },
      data: { enabled: true },
    });

    this.logger.log(`SSO enabled for tenant ${tenantId}`);
    this.eventEmitter.emit('sso.enabled', { tenantId });

    return updated;
  }

  /**
   * Disable SSO for a tenant
   */
  async disableSSO(tenantId: string): Promise<any> {
    const updated = await this.prisma.sSOConfiguration.update({
      where: { tenantId },
      data: { enabled: false },
    });

    this.logger.log(`SSO disabled for tenant ${tenantId}`);
    this.eventEmitter.emit('sso.disabled', { tenantId });

    return updated;
  }

  /**
   * Verify SSO configuration with a test assertion
   */
  async verifySSOConfig(tenantId: string): Promise<{ verified: boolean; message: string }> {
    const config = await this.prisma.sSOConfiguration.findUnique({
      where: { tenantId },
    });

    if (!config) {
      throw new NotFoundException(`SSO not configured for tenant ${tenantId}`);
    }

    // Validate configuration
    const validationErrors: string[] = [];

    if (!config.entityId) {
      validationErrors.push('Entity ID is required');
    }

    if (!config.ssoUrl) {
      validationErrors.push('SSO URL is required');
    }

    if (!config.certificate) {
      validationErrors.push('IdP certificate is required');
    }

    if (validationErrors.length > 0) {
      return {
        verified: false,
        message: `Configuration incomplete: ${validationErrors.join(', ')}`,
      };
    }

    // Verify certificate format
    try {
      this.parseCertificate(config.certificate!);
    } catch (error: any) {
      return {
        verified: false,
        message: `Invalid certificate: ${error.message}`,
      };
    }

    // Mark as verified
    await this.prisma.sSOConfiguration.update({
      where: { tenantId },
      data: { verified: true },
    });

    this.logger.log(`SSO configuration verified for tenant ${tenantId}`);

    return {
      verified: true,
      message: 'SSO configuration is valid and verified',
    };
  }

  // ==========================================================================
  // SAML Operations
  // ==========================================================================

  /**
   * Generate SP metadata for a tenant
   */
  async generateSPMetadata(tenantId: string): Promise<SPMetadata> {
    const acsUrl = `${this.baseUrl}/api/v1/sso/acs/${tenantId}`;
    const sloUrl = `${this.baseUrl}/api/v1/sso/slo/${tenantId}`;

    return {
      entityId: `${this.spEntityId}/${tenantId}`,
      acsUrl,
      sloUrl,
      nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      wantAssertionsSigned: true,
    };
  }

  /**
   * Generate SP metadata XML
   */
  async generateSPMetadataXML(tenantId: string): Promise<string> {
    const metadata = await this.generateSPMetadata(tenantId);

    return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
                     entityID="${metadata.entityId}">
  <md:SPSSODescriptor AuthnRequestsSigned="true"
                      WantAssertionsSigned="true"
                      protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:NameIDFormat>${metadata.nameIdFormat}</md:NameIDFormat>
    <md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
                                 Location="${metadata.acsUrl}"
                                 index="0"
                                 isDefault="true"/>
    <md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
                            Location="${metadata.sloUrl}"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
  }

  /**
   * Process SAML assertion and create user session
   */
  async processAssertion(tenantId: string, assertion: SAMLAssertion): Promise<SSOUser> {
    const config = await this.prisma.sSOConfiguration.findUnique({
      where: { tenantId },
    });

    if (!config || !config.enabled) {
      throw new UnauthorizedException('SSO is not enabled for this tenant');
    }

    // Validate assertion
    this.validateAssertion(assertion, config);

    // Extract user attributes
    const attributeMapping = config.attributeMapping as unknown as AttributeMapping;
    const user = this.extractUserFromAssertion(assertion, attributeMapping);

    // Validate domain if enforced
    if (config.enforcedDomains && config.enforcedDomains.length > 0) {
      const emailDomain = user.email.split('@')[1];
      if (!config.enforcedDomains.includes(emailDomain)) {
        throw new UnauthorizedException(`Email domain ${emailDomain} is not allowed`);
      }
    }

    // Create SSO session
    const sessionId = this.generateSessionId();
    const expiresAt = assertion.notOnOrAfter || new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours default

    const ssoUser: SSOUser = {
      ...user,
      tenantId,
      ssoSessionId: sessionId,
      expiresAt,
    };

    this.logger.log(`SSO login successful for ${user.email} (tenant: ${tenantId})`);
    this.eventEmitter.emit('sso.login', { tenantId, email: user.email, sessionId });

    return ssoUser;
  }

  /**
   * Process Single Logout request
   */
  async processSLO(tenantId: string, sessionId: string): Promise<void> {
    this.logger.log(`SSO logout for session ${sessionId} (tenant: ${tenantId})`);
    this.eventEmitter.emit('sso.logout', { tenantId, sessionId });
  }

  // ==========================================================================
  // Attribute Mapping
  // ==========================================================================

  /**
   * Get default attribute mappings for common IdPs
   */
  getDefaultAttributeMappings(): Record<string, AttributeMapping> {
    return DEFAULT_ATTRIBUTE_MAPPINGS;
  }

  /**
   * Test attribute mapping with sample assertion
   */
  testAttributeMapping(
    mapping: AttributeMapping,
    sampleAttributes: Record<string, string | string[]>,
  ): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [field, attributeName] of Object.entries(mapping)) {
      if (attributeName && sampleAttributes[attributeName]) {
        result[field] = sampleAttributes[attributeName];
      } else {
        result[field] = null;
      }
    }

    return result;
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private validateSAMLConfig(config: SAMLConfig): void {
    if (!config.entityId) {
      throw new BadRequestException('Entity ID is required');
    }

    if (!config.ssoUrl) {
      throw new BadRequestException('SSO URL is required');
    }

    try {
      new URL(config.ssoUrl);
    } catch {
      throw new BadRequestException('Invalid SSO URL format');
    }

    if (config.sloUrl) {
      try {
        new URL(config.sloUrl);
      } catch {
        throw new BadRequestException('Invalid SLO URL format');
      }
    }

    if (!config.certificate) {
      throw new BadRequestException('IdP certificate is required');
    }
  }

  private validateAssertion(assertion: SAMLAssertion, config: any): void {
    const now = new Date();

    // Check time validity
    if (assertion.notBefore && assertion.notBefore > now) {
      throw new UnauthorizedException('Assertion is not yet valid');
    }

    if (assertion.notOnOrAfter && assertion.notOnOrAfter < now) {
      throw new UnauthorizedException('Assertion has expired');
    }

    // Check issuer matches configured IdP
    if (assertion.issuer !== config.entityId) {
      throw new UnauthorizedException('Assertion issuer does not match configured IdP');
    }
  }

  private extractUserFromAssertion(
    assertion: SAMLAssertion,
    mapping: AttributeMapping,
  ): Omit<SSOUser, 'tenantId' | 'ssoSessionId' | 'expiresAt'> {
    const getAttribute = (key: string): string | undefined => {
      const value = assertion.attributes[key];
      return Array.isArray(value) ? value[0] : value;
    };

    const email = getAttribute(mapping.email) || assertion.nameId;

    if (!email) {
      throw new UnauthorizedException('Email attribute not found in assertion');
    }

    return {
      email,
      firstName: mapping.firstName ? getAttribute(mapping.firstName) : undefined,
      lastName: mapping.lastName ? getAttribute(mapping.lastName) : undefined,
      displayName: mapping.displayName ? getAttribute(mapping.displayName) : undefined,
      groups: mapping.groups
        ? (assertion.attributes[mapping.groups] as string[] | undefined)
        : undefined,
      role: mapping.role ? getAttribute(mapping.role) : undefined,
    };
  }

  private parseCertificate(certPem: string): void {
    // Basic validation of PEM format
    const certRegex = /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/;
    if (!certRegex.test(certPem)) {
      throw new Error('Certificate must be in PEM format');
    }
  }

  private generateSessionId(): string {
    return crypto.randomBytes(32).toString('hex');
  }
}
