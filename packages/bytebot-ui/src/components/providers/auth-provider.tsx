"use client";

import { useSession } from "@/lib/auth";
import { useRouter, usePathname } from "next/navigation";
import { useEffect } from "react";

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  // Check if auth is enabled
  const authEnabled = process.env.NEXT_PUBLIC_AUTH_ENABLED === 'true';
  const isPublicRoute = pathname === "/login";

  useEffect(() => {
    // Only run auth logic if auth is enabled
    if (!authEnabled) return;
    
    if (!isPending) {
      if (!session && !isPublicRoute) {
        // No session and not on a public route, redirect to login
        router.push("/login");
      } else if (session && isPublicRoute) {
        // Has session but on login page, redirect to home
        router.push("/");
      }
    }
  }, [session, isPending, isPublicRoute, router, authEnabled]);

  // If auth is disabled, just render children without any auth logic
  if (!authEnabled) {
    return <>{children}</>;
  }

  // Show loading spinner while checking auth
  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="border-t-primary h-8 w-8 animate-spin rounded-full border-4 border-gray-300"></div>
      </div>
    );
  }

  // Show login page for unauthenticated users
  if (!session && !isPublicRoute) {
    return null; // Router will handle redirect
  }

  return <>{children}</>;
}
