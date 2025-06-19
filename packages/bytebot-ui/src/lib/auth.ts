import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: 'http://localhost:9991/api/auth',
  session: {
    cookieName: 'better-auth.session',
  },
  fetchOptions: {
    credentials: 'include', // Include cookies in cross-origin requests
  },
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  getSession,
} = authClient;
