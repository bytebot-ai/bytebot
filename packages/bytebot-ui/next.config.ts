import type { NextConfig } from "next";
import dotenv from "dotenv";

dotenv.config();

// Helper function to build CSP directive based on environment
function buildCSP(): string {
  const isDevelopment = process.env.NODE_ENV === 'development';
  
  // Base CSP directives
  const baseDirectives = [
    "default-src 'self'",
    "style-src 'self' 'unsafe-inline'", // Needed for Tailwind CSS
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ];
  
  // Build script-src directive conditionally
  const scriptSrcParts = ["'self'"];
  
  if (isDevelopment) {
    // Development: Allow unsafe-eval for hot reloading and dev tools
    scriptSrcParts.push("'unsafe-eval'");
    scriptSrcParts.push("'unsafe-inline'"); // For dev convenience
  } else {
    // Production: Stricter policy
    // Note: Add nonces here when implementing server-side nonce generation
    // scriptSrcParts.push("'nonce-{NONCE_PLACEHOLDER}'");
    
    // For now, allow unsafe-inline but prepare for nonce-based approach
    scriptSrcParts.push("'unsafe-inline'");
    
    // TODO: Replace 'unsafe-inline' with nonce-based CSP
    // 1. Generate nonce in middleware or layout
    // 2. Inject nonce into CSP header: `'nonce-${nonce}'`
    // 3. Add nonce to inline scripts: <script nonce={nonce}>
    // 4. Remove 'unsafe-inline' from script-src
  }
  
  const scriptSrc = `script-src ${scriptSrcParts.join(' ')}`;
  
  return [...baseDirectives, scriptSrc].join('; ');
}

const nextConfig: NextConfig = {
  transpilePackages: ["@bytebot/shared"],
  async headers() {
    return [
      {
        // Apply CSP to all routes
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: buildCSP()
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY'
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin'
          }
        ]
      }
    ];
  }
};

export default nextConfig;

/*
 * NONCE-BASED CSP IMPLEMENTATION GUIDE
 * ====================================
 * 
 * To implement nonce-based CSP for enhanced security:
 * 
 * 1. MIDDLEWARE SETUP (middleware.ts):
 *    - Generate unique nonce per request: crypto.randomBytes(16).toString('base64')
 *    - Store nonce in request headers or context
 *    - Pass nonce to CSP header generation
 * 
 * 2. CSP HEADER UPDATE:
 *    - Replace 'unsafe-inline' with 'nonce-{generated_nonce}'
 *    - Update buildCSP() function to accept nonce parameter
 *    - Example: `script-src 'self' 'nonce-${nonce}'`
 * 
 * 3. SERVER COMPONENTS/LAYOUTS:
 *    - Access nonce from request context
 *    - Pass nonce to client components via props
 *    - Add nonce to any inline <script> tags
 * 
 * 4. INLINE SCRIPTS:
 *    - Add nonce attribute: <script nonce={nonce}>...</script>
 *    - Update any dynamic script injection to include nonce
 *    - Ensure all inline scripts have the nonce attribute
 * 
 * 5. TESTING:
 *    - Verify CSP violations are blocked in browser console
 *    - Test that legitimate scripts with nonces work correctly
 *    - Validate nonce uniqueness across requests
 * 
 * Example nonce generation:
 * ```typescript
 * import { headers } from 'next/headers';
 * import crypto from 'crypto';
 * 
 * export function generateNonce(): string {
 *   return crypto.randomBytes(16).toString('base64');
 * }
 * ```
 * 
 * Example usage in component:
 * ```tsx
 * function MyComponent({ nonce }: { nonce: string }) {
 *   return (
 *     <script nonce={nonce}>
 *       {`console.log('This script has a nonce');`}
 *     </script>
 *   );
 * }
 * ```
 */