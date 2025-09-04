import React, { useRef, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight02Icon, Attachment01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";

interface FileWithBase64 {
  name: string;
  base64: string;
  type: string;
  size: number;
}

interface ChatInputProps {
  input: string;
  isLoading: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onFileUpload?: (files: FileWithBase64[]) => void;
  minLines?: number;
  placeholder?: string;
}

export function ChatInput({
  input,
  isLoading,
  onInputChange,
  onSend,
  onFileUpload,
  minLines = 1,
  placeholder = "Give Bytebot a task to work on...",
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFiles, setSelectedFiles] = useState<FileWithBase64[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>("");
  
  const MAX_FILES = 5;
  const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB per file in bytes

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSend();
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    
    setErrorMessage("");

    // Check max files limit
    if (selectedFiles.length + files.length > MAX_FILES) {
      setErrorMessage(`Maximum ${MAX_FILES} files allowed`);
      e.target.value = '';
      return;
    }
    

    // Check individual file sizes
    const oversizedFiles: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.size > MAX_FILE_SIZE) {
        oversizedFiles.push(`${file.name} (${formatFileSize(file.size)})`);
      }
    }
    
    if (oversizedFiles.length > 0) {
      setErrorMessage(`File(s) exceed 30MB limit: ${oversizedFiles.join(', ')}`);
      e.target.value = '';
      return;
    }

    const newFiles: FileWithBase64[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const base64 = await convertToBase64(file);
      
      newFiles.push({
        name: file.name,
        base64: base64,
        type: file.type,
        size: file.size,
      });
    }

    const updatedFiles = [...selectedFiles, ...newFiles];
    setSelectedFiles(updatedFiles);
    
    if (onFileUpload) {
      onFileUpload(updatedFiles);
    }

    // Reset the input
    e.target.value = '';
  };

  const convertToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
    });
  };

  const removeFile = (index: number) => {
    const updatedFiles = selectedFiles.filter((_, i) => i !== index);
    setSelectedFiles(updatedFiles);
    setErrorMessage("");
    
    if (onFileUpload) {
      onFileUpload(updatedFiles);
    }
  };

  const triggerFileInput = () => {
    fileInputRef.current?.click();
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = "auto";

    // Calculate minimum height based on minLines
    const lineHeight = 24; // approximate line height in pixels
    const minHeight = lineHeight * minLines + 12;

    // Set height to scrollHeight or minHeight, whichever is larger
    const newHeight = Math.max(textarea.scrollHeight, minHeight);
    textarea.style.height = `${newHeight}px`;
  }, [input, minLines]);

  // Determine button position based on minLines
  const buttonPositionClass =
    minLines > 1 ? "bottom-1.5" : "top-1/2 -translate-y-1/2";

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileSelect}
        className="hidden"
        accept="*/*"
      />
      
      {errorMessage && (
        <div className="mb-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">
          {errorMessage}
        </div>
      )}
      
      {selectedFiles.length > 0 && (
        <div className="mb-2">
          <div className="mb-1 flex items-center justify-between text-xs text-gray-500">
            <span>{selectedFiles.length} / {MAX_FILES} files</span>
            <span>Max 30MB per file</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedFiles.map((file, index) => (
              <div
                key={index}
                className="flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1 text-sm"
              >
                <span className="max-w-[200px] truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() => removeFile(index)}
                  className="ml-1 rounded-sm hover:bg-gray-200"
                >
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    className="h-3 w-3 text-gray-600"
                  />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      
      <form onSubmit={handleSubmit} className="relative">
        <textarea
          ref={textareaRef}
          placeholder={placeholder}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          className={cn(
            "placeholder:text-bytebot-bronze-light-10 w-full rounded-lg py-2 pr-16 pl-3 placeholder:text-[13px]",
            "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-bytebot-bronze-light-7 flex min-w-0 border bg-transparent text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
            "resize-none overflow-hidden",
          )}
          disabled={isLoading}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <div className={`absolute right-2 ${buttonPositionClass} flex items-center gap-1`}>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-6 w-6 cursor-pointer rounded-sm hover:bg-gray-100"
            onClick={triggerFileInput}
            disabled={isLoading}
          >
            <HugeiconsIcon
              icon={Attachment01Icon}
              className="h-4 w-4 text-gray-600"
            />
          </Button>
          
          {isLoading ? (
            <div className="border-bytebot-bronze-light-7 border-t-primary h-5 w-5 animate-spin rounded-full border-2" />
          ) : (
            <Button
              type="submit"
              variant="ghost"
              size="icon"
              className="bg-bytebot-bronze-dark-7 hover:bg-bytebot-bronze-dark-6 h-6 w-6 cursor-pointer rounded-sm"
              disabled={isLoading}
            >
              <HugeiconsIcon
                icon={ArrowRight02Icon}
                className="h-4 w-4 text-white"
              />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
