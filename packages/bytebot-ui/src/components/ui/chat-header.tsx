'use client';

import React from 'react';
import { ChevronDown, ArrowLeftToLine, ArrowRightToLine, X, Move } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ContainerPosition } from './draggable-container';

interface ChatHeaderProps {
  title: string;
  onClose?: () => void;
  onSizeChange: () => void;
  onPositionChange: (position: ContainerPosition) => void;
  currentPosition: ContainerPosition;
  onDragStart: (e: React.MouseEvent) => void;
}

export function ChatHeader({
  title,
  onClose,
  onSizeChange,
  onPositionChange,
  currentPosition,
  onDragStart,
}: ChatHeaderProps) {
  // Get the appropriate icon for the current size mode
  const getSizeIcon = () => {
    // Removed switch statement as it was not being used in the provided code edit
    return <ChevronDown className="h-4 w-4" />;
  };

  return (
    <div
      className="flex items-center justify-between px-4 py-2 bg-background/80 border-b border-border/20 cursor-move select-none"
      onMouseDown={onDragStart}
    >
      <div className="flex items-center gap-2">
        <div className="flex-shrink-0 w-5 h-5 rounded-full bg-primary flex items-center justify-center">
          <span className="text-primary-foreground text-xs font-medium">B</span>
        </div>
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      
      <div className="flex items-center space-x-1">
        {/* Position controls */}
        <button
          onClick={() => onPositionChange('left')}
          className={cn(
            'p-1 rounded-sm transition-colors',
            currentPosition === 'left'
              ? 'bg-muted text-primary'
              : 'hover:bg-muted/40'
          )}
          aria-label="Snap to left"
        >
          <ArrowLeftToLine className="h-4 w-4" />
        </button>
        <button
          onClick={() => onPositionChange('free')}
          className={cn(
            'p-1 rounded-sm transition-colors',
            currentPosition === 'free'
              ? 'bg-muted text-primary'
              : 'hover:bg-muted/40'
          )}
          aria-label="Free positioning"
        >
          <Move className="h-4 w-4" />
        </button>
        <button
          onClick={() => onPositionChange('right')}
          className={cn(
            'p-1 rounded-sm transition-colors',
            currentPosition === 'right'
              ? 'bg-muted text-primary'
              : 'hover:bg-muted/40'
          )}
          aria-label="Snap to right"
        >
          <ArrowRightToLine className="h-4 w-4" />
        </button>
        
        {/* Size toggle */}
        <button
          onClick={onSizeChange}
          className="p-1 rounded-sm hover:bg-muted/40 transition-colors"
          aria-label="Toggle size"
        >
          {getSizeIcon()}
        </button>
        
        {/* Close button */}
        {onClose && (
          <button
            onClick={onClose}
            className="p-1 rounded-sm hover:bg-muted/40 transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
