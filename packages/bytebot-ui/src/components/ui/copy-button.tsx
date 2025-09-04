import React, { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Copy01Icon } from '@hugeicons/core-free-icons';
import { Button } from './button';
import { copyToClipboard } from '@/utils/clipboard';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
  text: string;
  className?: string;
  size?: 'sm' | 'icon';
  variant?: 'ghost' | 'outline' | 'secondary';
}

export function CopyButton({ 
  text, 
  className,
  size = 'icon',
  variant = 'ghost'
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    const success = await copyToClipboard(text);
    if (success) {
      setCopied(true);
      // Reset the copied state after 2 seconds
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <Button
      onClick={handleCopy}
      variant={variant}
      size={size}
      className={cn(
        'h-6 w-6 transition-all duration-200',
        copied ? 'text-green-600' : 'text-gray-500 hover:text-gray-700',
        className
      )}
      title={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? (
        <span className="text-xs font-medium">✓</span>
      ) : (
        <HugeiconsIcon icon={Copy01Icon} className="h-3 w-3" />
      )}
    </Button>
  );
}