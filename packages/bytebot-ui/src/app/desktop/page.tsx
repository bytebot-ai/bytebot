"use client";

import React, { useEffect, useRef, useState } from "react";
import { Header } from "@/components/layout/Header";
// display WebRTC stream from Neko

export default function TaskPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  const [isMounted, setIsMounted] = useState(false);

  // Set isMounted to true after component mounts
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Calculate the container size on mount and window resize
  useEffect(() => {
    if (!isMounted) return;

    const updateSize = () => {
      if (!containerRef.current) return;

      const parentWidth =
        containerRef.current.parentElement?.offsetWidth ||
        containerRef.current.offsetWidth;
      const parentHeight =
        containerRef.current.parentElement?.offsetHeight ||
        containerRef.current.offsetHeight;

      // Calculate the maximum size while maintaining 1280:960 aspect ratio
      let width, height;
      const aspectRatio = 1280 / 960;

      if (parentWidth / parentHeight > aspectRatio) {
        // Width is the limiting factor
        height = parentHeight;
        width = height * aspectRatio;
      } else {
        // Height is the limiting factor
        width = parentWidth;
        height = width / aspectRatio;
      }

      // Cap at maximum dimensions
      width = Math.min(width, 1280);
      height = Math.min(height, 960);

      setContainerSize({ width, height });
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, [isMounted]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />

      <main className="m-2 flex-1 overflow-hidden px-2 py-4">
        <div className="flex h-full items-center justify-center">
          {/* Main container */}
          <div className="w-[60%]">
            <div
              ref={containerRef}
              className="border-bytebot-bronze-light-5 shadow-bytebot flex aspect-[4/3] w-full flex-col rounded-lg border"
            >
              {/* Status Header */}
              <div className="border-bytebot-bronze-light-5 bg-bytebot-bronze-light-1 flex items-center justify-between rounded-t-lg border-b px-4 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-bytebot-bronze-dark-8 text-sm font-medium">
                    Desktop - Live View
                  </span>
                </div>
              </div>

              <div className="flex-1 rounded-b-[14px]">
                <div
                  style={{
                    width: `${containerSize.width}px`,
                    height: `${containerSize.height}px`,
                    maxWidth: "100%",
                  }}
                >
                  <iframe
                    src="/api/proxy/neko/"
                    style={{ width: "100%", height: "100%", border: "none" }}
                    allow="fullscreen"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
