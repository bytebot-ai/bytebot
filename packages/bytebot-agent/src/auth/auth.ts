import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // 24 hours (update session if it's older than this)
    cookieName: 'better-auth.session', // Match frontend cookie name
  },
  secret: process.env.BETTER_AUTH_SECRET || 'fallback-secret-change-in-production',
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:9991/api/auth',
  trustedOrigins: [
    'http://localhost:9992', // Frontend URL
    'http://localhost:9991', // Backend URL
  ],
  advanced: {
    crossSubDomainCookies: {
      enabled: false, // Since we're on localhost with different ports
    },
  },
});

export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.Session.user;
