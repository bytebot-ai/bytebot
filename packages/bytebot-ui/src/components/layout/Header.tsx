import React, { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { useTheme } from "next-themes";
import { ThemeToggle } from "@/components/theme-toggle";
import { FileText, MessageSquare, Send } from "lucide-react";

// Uncommenting interface if needed in the future
// interface HeaderProps {
//   currentTaskId?: string | null;
//   onNewConversation?: () => void;
// }

export function Header() {
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // After mounting, we can safely show the theme-dependent content
  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <header className="flex items-center justify-between px-6 py-3 bg-bronze-light-2 border-b border-bronze-light-4/30">
      {/* Logo on the left */}
      <div className="flex items-center gap-2 w-1/4">
        <Link href="/">
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
            <div className="h-8 w-[100px]" />
          )}
        </Link>
      </div>
      
      {/* Centered navigation */}
      <div className="flex-1 flex justify-center">
        <nav className="flex items-center space-x-8">
          <Link 
            href="/tasks" 
            className="flex items-center gap-2 text-sm font-medium text-bronze-light-10 hover:text-blue-light-6 transition-colors"
          >
            <MessageSquare className="h-4 w-4" />
            <span>Tasks</span>
          </Link>
          <Link 
            href="/documentation" 
            className="flex items-center gap-2 text-sm font-medium text-bronze-light-10 hover:text-blue-light-6 transition-colors"
          >
            <FileText className="h-4 w-4" />
            <span>Documentation</span>
          </Link>
          <Link 
            href="/feedback" 
            className="flex items-center gap-2 text-sm font-medium text-bronze-light-10 hover:text-blue-light-6 transition-colors"
          >
            <Send className="h-4 w-4" />
            <span>Feedback</span>
          </Link>
        </nav>
      </div>
      
      {/* Theme toggle on the right */}
      <div className="flex items-center justify-end w-1/4">
        <ThemeToggle />
      </div>
    </header>
  );
}
