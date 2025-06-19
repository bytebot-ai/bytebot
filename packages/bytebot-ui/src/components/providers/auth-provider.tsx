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

  const isPublicRoute = pathname === "/login";

  useEffect(() => {
    if (!isPending) {
      if (!session && !isPublicRoute) {
        // No session and not on a public route, redirect to login
        router.push("/login");
      } else if (session && isPublicRoute) {
        // Has session but on login page, redirect to home
        router.push("/");
      }
    }
  }, [session, isPending, isPublicRoute, router]);

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
