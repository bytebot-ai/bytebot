/**
 * DNS-1123 Naming Utility
 * v1.0.15: Safe Kubernetes resource name generation
 *
 * Kubernetes resource names must follow DNS-1123 subdomain rules:
 * - At most 63 characters for labels (253 for full names)
 * - Only lowercase alphanumeric characters, '-', or '.'
 * - Must start and end with an alphanumeric character
 *
 * This utility ensures workspace IDs are safely converted to valid
 * Kubernetes resource names while maintaining uniqueness.
 */

import * as crypto from 'crypto';

// Maximum length for Kubernetes resource names (label constraint)
const MAX_K8S_NAME_LENGTH = 63;

// Reserved length for prefix (e.g., "workspace-" = 10, "desktop-" = 8)
const PREFIX_WORKSPACE = 'workspace-';
const PREFIX_DESKTOP = 'desktop-';

// Hash suffix length when truncation is needed (e.g., "-a1b2c3" = 7)
const HASH_SUFFIX_LENGTH = 7;

/**
 * DNS-1123 label validation regex
 * - Starts with alphanumeric
 * - Contains only lowercase alphanumeric or hyphens
 * - Ends with alphanumeric
 * - Max 63 characters
 */
const DNS_1123_LABEL_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validates if a string is a valid DNS-1123 label
 */
export function isValidDNS1123Label(name: string): boolean {
  if (!name || name.length > MAX_K8S_NAME_LENGTH) {
    return false;
  }
  return DNS_1123_LABEL_REGEX.test(name);
}

/**
 * Sanitizes a string to be DNS-1123 compliant
 * - Converts to lowercase
 * - Replaces invalid characters with hyphens
 * - Removes leading/trailing hyphens
 * - Collapses consecutive hyphens
 */
export function sanitizeForDNS1123(input: string): string {
  if (!input) return '';

  return input
    .toLowerCase()
    // Replace underscores and other invalid chars with hyphens
    .replace(/[^a-z0-9-]/g, '-')
    // Collapse consecutive hyphens
    .replace(/-+/g, '-')
    // Remove leading hyphens
    .replace(/^-+/, '')
    // Remove trailing hyphens
    .replace(/-+$/, '');
}

/**
 * Generates a short hash suffix for uniqueness
 * Uses first 6 characters of SHA-256 hash
 */
function generateHashSuffix(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return hash.substring(0, 6);
}

/**
 * Creates a safe Kubernetes resource name from a workspace ID
 *
 * Strategy:
 * 1. Sanitize the workspace ID
 * 2. If sanitized + prefix fits within limits, use it directly
 * 3. If too long, truncate and add hash suffix for uniqueness
 *
 * @param workspaceId - The original workspace identifier
 * @param prefix - Resource prefix (e.g., "workspace-", "desktop-")
 * @returns Safe Kubernetes resource name
 */
export function toSafeResourceName(
  workspaceId: string,
  prefix: string,
): string {
  const sanitized = sanitizeForDNS1123(workspaceId);

  if (!sanitized) {
    throw new Error('Workspace ID results in empty name after sanitization');
  }

  const fullName = `${prefix}${sanitized}`;

  // If it fits, use it directly
  if (fullName.length <= MAX_K8S_NAME_LENGTH) {
    return fullName;
  }

  // Need to truncate - calculate available space
  // Format: {prefix}{truncated-id}-{hash}
  const hashSuffix = `-${generateHashSuffix(workspaceId)}`;
  const availableForId =
    MAX_K8S_NAME_LENGTH - prefix.length - hashSuffix.length;

  if (availableForId < 1) {
    throw new Error(`Prefix "${prefix}" is too long for safe naming`);
  }

  // Truncate and ensure we don't end with a hyphen
  let truncated = sanitized.substring(0, availableForId);
  truncated = truncated.replace(/-+$/, '');

  // If truncation removed everything, use minimum characters
  if (!truncated) {
    truncated = sanitized.substring(0, 1);
  }

  return `${prefix}${truncated}${hashSuffix}`;
}

/**
 * Creates a safe workspace PVC name
 * Format: workspace-{safe-id}
 */
export function toWorkspacePVCName(workspaceId: string): string {
  return toSafeResourceName(workspaceId, PREFIX_WORKSPACE);
}

/**
 * Creates a safe workspace pod name
 * Format: desktop-{safe-id}
 */
export function toWorkspacePodName(workspaceId: string): string {
  return toSafeResourceName(workspaceId, PREFIX_DESKTOP);
}

/**
 * Validates a workspace ID and returns validation result
 */
export interface WorkspaceIdValidation {
  valid: boolean;
  error?: string;
  sanitized?: string;
  pvcName?: string;
  podName?: string;
}

export function validateWorkspaceId(workspaceId: string): WorkspaceIdValidation {
  if (!workspaceId) {
    return { valid: false, error: 'Workspace ID is required' };
  }

  if (workspaceId.length > 253) {
    return {
      valid: false,
      error: 'Workspace ID must be 253 characters or less',
    };
  }

  // Check for completely invalid input
  const sanitized = sanitizeForDNS1123(workspaceId);
  if (!sanitized) {
    return {
      valid: false,
      error:
        'Workspace ID must contain at least one alphanumeric character',
    };
  }

  try {
    const pvcName = toWorkspacePVCName(workspaceId);
    const podName = toWorkspacePodName(workspaceId);

    return {
      valid: true,
      sanitized,
      pvcName,
      podName,
    };
  } catch (error: any) {
    return {
      valid: false,
      error: error.message,
    };
  }
}

/**
 * Extracts workspace ID from a resource name
 * Note: This is a best-effort reverse operation; hashed names cannot be reversed
 */
export function extractWorkspaceIdFromResourceName(
  resourceName: string,
  prefix: string,
): string | null {
  if (!resourceName.startsWith(prefix)) {
    return null;
  }
  return resourceName.substring(prefix.length);
}
