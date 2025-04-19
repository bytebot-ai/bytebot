import React from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ChatInputProps {
  input: string;
  isLoading: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
}

export function ChatInput({ input, isLoading, onInputChange, onSend }: ChatInputProps) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSend();
  };

  return (
    <div className="p-3 border-t border-bronze-light-4/30">
      <form onSubmit={handleSubmit} className="relative">
        <Input
          placeholder="Ask me to do something..."
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          className="w-full py-2 px-4 pr-10 rounded-md text-bronze-light-12 bg-bronze-light-1 border-bronze-light-4/50"
          disabled={isLoading}
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          {isLoading ? (
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-bronze-light-5 border-t-blue-light-6" />
          ) : (
            <Button
              type="submit"
              variant="ghost"
              size="icon"
              className="rounded-full h-6 w-6 hover:bg-bronze-light-3/50 text-blue-light-6"
              disabled={isLoading || !input.trim()}
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
