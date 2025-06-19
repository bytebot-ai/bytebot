import React, { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { useTheme } from "next-themes";
import { HugeiconsIcon } from '@hugeicons/react'
import { DocumentCodeIcon, TaskDaily01Icon, Home01Icon, User03Icon, Logout01Icon } from '@hugeicons/core-free-icons'
import { usePathname } from 'next/navigation';
import { Button } from "@/components/ui/button";
import { signOut, useSession } from "@/lib/auth";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Uncommenting interface if needed in the future
// interface HeaderProps {
//   currentTaskId?: string | null;
//   onNewConversation?: () => void;
// }

export function Header() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const pathname = usePathname();
  const { data: session } = useSession();

  // After mounting, we can safely show the theme-dependent content
  useEffect(() => {
    setMounted(true);
  }, []);

  // Function to determine if a link is active
  const isActive = (path: string) => {
    if (path === '/') {
      return pathname === '/';
    }
    return pathname?.startsWith(path);
  };

  // Get classes for navigation links based on active state
  const getLinkClasses = (path: string) => {
    const baseClasses = "flex items-center gap-1.5 transition-colors px-3 py-1.5 rounded-lg";
    const activeClasses = "bg-bytebot-bronze-light-a3 text-bytebot-bronze-light-12";
    const inactiveClasses = "text-bytebot-bronze-dark-9 hover:bg-bytebot-bronze-light-a1 hover:text-bytebot-bronze-light-12";
    
    return `${baseClasses} ${isActive(path) ? activeClasses : inactiveClasses}`;
  };

  return (
    <header className="flex items-center justify-between p-4 border-b bg-background">
      <div className="flex items-center gap-6">
        {/* Logo without link */}
        <div>
          {mounted ? (
            <Image
              src={
                resolvedTheme === "dark"
                  ? "/bytebot_transparent_logo_white.svg"
                  : "/bytebot_transparent_logo_dark.svg"
              }
              alt="Bytebot Logo"
              width={100}
              height={30}
              className="h-8 w-auto"
            />
          ) : (
            <div className="h-10 w-[100px]" />
          )}
        </div>
        <div className="border border-l-[0.5px] border-bytebot-bronze-dark-11 h-5"></div>
        <div className="flex items-center gap-2">
          <Link href="/" className={getLinkClasses('/')}>
            <HugeiconsIcon icon={Home01Icon} className="w-4 h-4" />
            <span className="text-sm">Home</span>
          </Link>
          <Link href="/tasks" className={getLinkClasses('/tasks')}>
            <HugeiconsIcon icon={TaskDaily01Icon} className="w-4 h-4" />
            <span className="text-sm">Tasks</span>
          </Link>
          <Link href="https://docs.bytebot.ai/quickstart" className={getLinkClasses('https://docs.bytebot.ai')}>
            <HugeiconsIcon icon={DocumentCodeIcon} className="w-4 h-4" />
            <span className="text-sm">Docs</span>
          </Link>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {session && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="flex items-center gap-2">
                <HugeiconsIcon icon={User03Icon} className="w-4 h-4" />
                <span className="text-sm">{session.user.name || session.user.email}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem 
                onClick={() => signOut()} 
                className="flex items-center gap-2 text-red-600"
              >
                <HugeiconsIcon icon={Logout01Icon} className="w-4 h-4" />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </header>
  );
}
