import React, { useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { HugeiconsIcon } from '@hugeicons/react'
import { ArrowRight02Icon } from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils';

interface ChatInputProps {
  input: string;
  isLoading: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  minLines?: number;
  placeholder?: string;
}

export function ChatInput({ input, isLoading, onInputChange, onSend, minLines = 1, placeholder = "Ask me to do something..." }: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSend();
  };

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = 'auto';
    
    // Calculate minimum height based on minLines
    const lineHeight = 24; // approximate line height in pixels
    const minHeight = lineHeight * minLines + 12;
    
    // Set height to scrollHeight or minHeight, whichever is larger
    const newHeight = Math.max(textarea.scrollHeight, minHeight);
    textarea.style.height = `${newHeight}px`;
  }, [input, minLines]);

  // Determine button position based on minLines
  const buttonPositionClass = minLines > 1 ? "bottom-1.5" : "top-1/2 -translate-y-1/2";

  return (
    <div>
      <form onSubmit={handleSubmit} className="relative">
        <textarea
          ref={textareaRef}
          placeholder={placeholder}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          className={cn(
            "w-full py-1.5 pl-3 pr-10 rounded-lg placeholder:text-bytebot-bronze-light-10 placeholder:text-[13px]",
            "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-bytebot-bronze-light-7 flex min-w-0 border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
            "resize-none overflow-hidden"
          )}
          disabled={isLoading}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <div className={`absolute right-2 ${buttonPositionClass}`}>
          {isLoading ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-bytebot-bronze-light-7 border-t-primary" />
          ) : (
            <Button
              type="submit"
              variant="ghost"
              size="icon"
              className="rounded-sm bg-bytebot-bronze-dark-7 w-6 h-6 hover:bg-bytebot-bronze-dark-6 cursor-pointer"
              disabled={isLoading}
            >
              <HugeiconsIcon icon={ArrowRight02Icon} className="text-white w-4 h-4" />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
