import React from "react";
import { isTextContentBlock, ToolResultContentBlock } from "@bytebot/shared";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

interface ErrorContentProps {
  block: ToolResultContentBlock;
}

export function ErrorContent({ block }: ErrorContentProps) {
  return (
    <div className="mb-3 rounded-md border border-red-200 bg-red-100 p-2">
      <div className="flex items-center justify-start gap-2">
        <HugeiconsIcon
          icon={AlertCircleIcon}
          className="h-5 w-5 text-red-800"
        />
        <div className="prose prose-sm max-w-none text-sm text-red-800">
          {isTextContentBlock(block.content?.[0])
            ? block.content?.[0].text
            : "Error running tool"}
        </div>
      </div>
    </div>
  );
}
