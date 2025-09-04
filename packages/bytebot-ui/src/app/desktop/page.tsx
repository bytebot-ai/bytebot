"use client";

import React from "react";
import { Header } from "@/components/layout/Header";
import { DesktopContainer } from "@/components/ui/desktop-container";

export default function DesktopPage() {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />

      <main className="m-2 flex-1 overflow-hidden px-2 py-4">
        <div className="flex h-full items-center justify-center">
          {/* Main container */}
          <div className="w-[60%]">
            <DesktopContainer viewOnly={false} status="live_view">
              {/* No action buttons for desktop page */}
            </DesktopContainer>
          </div>
        </div>
      </main>
    </div>
  );
}
