'use client';

import type React from "react";
import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { ChatHeader } from "./chat-header";

export type ContainerSize = "full" | "compact" | "minimized";
export type ContainerPosition = "left" | "right" | "free";

export interface DraggableContainerProps {
  title: string;
  children: React.ReactNode;
  defaultPosition?: { x: number; y: number };
  className?: string;
  onClose?: () => void;
  parentSize: { width: number; height: number };
  minWidth?: number;
  defaultSnap?: ContainerPosition;
}

export function DraggableContainer({
  title,
  children,
  defaultPosition,
  className,
  onClose,
  parentSize,
  minWidth = 300, // Default minimum width of 300px
  defaultSnap = "right", // Default to right side
}: DraggableContainerProps) {
  // Use a safe initial position that doesn't depend on window
  const [position, setPosition] = useState(defaultPosition || { x: 0, y: 0 });
  const [sizeMode, setSizeMode] = useState<ContainerSize>("full");
  const [isDragging, setIsDragging] = useState(false);
  const [currentPosition, setCurrentPosition] = useState<ContainerPosition>(defaultSnap);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const [isMounted, setIsMounted] = useState(false);

  // Set isMounted to true after component mounts
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Calculate container width with minimum constraint
  const getWidth = useCallback(() => {
    const calculatedWidth = parentSize.width * (1 / 4); // Changed from 1/5 to 1/4
    return Math.max(calculatedWidth, minWidth); // Ensure width is never less than minWidth
  }, [parentSize.width, minWidth]);

  const getHeight = useCallback(() => {
    // When snapped to left or right, fill the height
    if (currentPosition === "left" || currentPosition === "right") {
      return parentSize.height;
    }
    
    // In free mode, use the size mode
    switch (sizeMode) {
      case "full":
        return parentSize.height * (7 / 8);
      case "compact":
        return parentSize.height * (3 / 8);
      case "minimized":
        return "auto";
    }
  }, [sizeMode, parentSize.height, currentPosition]);

  // Update position based on snap position
  const updatePositionBasedOnSnap = useCallback((snap: ContainerPosition) => {
    const containerWidth = getWidth();
    let newX = 0;
    const centerY = (window.innerHeight - parentSize.height) / 2; // Position at the top of the parent

    if (snap === "right") {
      // Position on the right side of the parent container
      newX = (window.innerWidth + parentSize.width) / 2;
    } else if (snap === "left") {
      // Position on the left side of the parent container
      newX = (window.innerWidth - parentSize.width) / 2 - containerWidth;
    } else {
      // Free position - default to right side
      newX = window.innerWidth - containerWidth - 20;
    }

    setPosition({
      x: newX,
      y: centerY,
    });
  }, [getWidth, parentSize.width, parentSize.height]);

  // Handle position change from the header controls
  const handlePositionChange = useCallback((newPosition: ContainerPosition) => {
    setCurrentPosition(newPosition);
    updatePositionBasedOnSnap(newPosition);
  }, [updatePositionBasedOnSnap]);

  // Calculate and set initial position after component mounts
  useEffect(() => {
    if (isMounted) {
      updatePositionBasedOnSnap(defaultSnap);
    }
  }, [isMounted, defaultSnap, updatePositionBasedOnSnap]);

  // Update position if window size changes
  useEffect(() => {
    if (!isMounted) return;

    const updatePosition = () => {
      // Only update if not manually positioned by user
      if (!isDragging) {
        updatePositionBasedOnSnap(currentPosition);
      }
    };

    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [parentSize, isDragging, isMounted, currentPosition, updatePositionBasedOnSnap]);

  // Handle dragging
  useEffect(() => {
    if (!isMounted) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const newX = e.clientX - dragStartRef.current.x;
        const newY = e.clientY - dragStartRef.current.y;

        // Ensure the container stays within the viewport bounds
        const containerWidth = getWidth();
        const containerHeight =
          typeof getHeight() === "string" ? 40 : (getHeight() as number); // 40px for header height when minimized

        const maxX = window.innerWidth - containerWidth;
        const maxY = window.innerHeight - containerHeight;
        
        // No automatic snapping, just constrain to viewport
        setPosition({
          x: Math.max(0, Math.min(newX, maxX)),
          y: Math.max(0, Math.min(newY, maxY)),
        });
        
        // When user starts dragging, set position mode to free
        if (currentPosition !== "free") {
          setCurrentPosition("free");
        }
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, position, isMounted, getWidth, getHeight, currentPosition]);

  // Cycle through size modes
  const cycleSizeMode = () => {
    if (sizeMode === "full") {
      setSizeMode("compact");
    } else if (sizeMode === "compact") {
      setSizeMode("minimized");
    } else {
      setSizeMode("full");
    }
  };

  // Handle drag start
  const handleDragStart = (e: React.MouseEvent) => {
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
  };

  // Don't render anything during SSR
  if (!isMounted) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "fixed shadow-md rounded-xl border border-border/30 bg-background/95 backdrop-blur-sm overflow-hidden",
        className
      )}
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
        width: `${getWidth()}px`,
        height: getHeight(),
        zIndex: 50,
      }}
    >
      {/* Header with logo and position controls */}
      <ChatHeader
        title={title}
        onClose={onClose}
        onDragStart={handleDragStart}
        onSizeChange={cycleSizeMode}
        onPositionChange={handlePositionChange}
        currentPosition={currentPosition}
      />
      
      {/* Content area */}
      <div className={cn("h-full overflow-auto", sizeMode === "minimized" && "hidden")}>
        {children}
      </div>
    </div>
  );
}

interface ViewProps {
  title: string;
  icon?: React.ReactNode;
  id?: string;
  children: React.ReactNode;
}

export function View({ title, icon, id, children }: ViewProps) {
  return (
    <div id={id} className="border rounded-md p-4">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <h4 className="text-sm font-semibold">{title}</h4>
      </div>
      {children}
    </div>
  );
}
