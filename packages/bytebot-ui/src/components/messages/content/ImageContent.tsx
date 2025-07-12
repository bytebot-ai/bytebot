import React from "react";
import Image from "next/image";
import { HugeiconsIcon } from "@hugeicons/react";
import { Camera01Icon } from "@hugeicons/core-free-icons";
import { ImageContentBlock } from "@bytebot/shared";

interface ImageContentProps {
  block: ImageContentBlock;
}

export function ImageContent({ block }: ImageContentProps) {
  // Use a fixed size for the image since width/height are not available on block.source
  const width = 250;
  const height = 250;
  return (
    <div className="max-w-4/5 mb-3">
      <div className="flex items-center gap-2 mb-2">
        <HugeiconsIcon
          icon={Camera01Icon}
          className="text-bytebot-bronze-dark-9 h-4 w-4"
        />
        <p className="text-bytebot-bronze-light-11 text-xs">
          Screenshot taken
        </p>
      </div>
      <div className="border border-bytebot-bronze-light-7 rounded-md overflow-hidden inline-block">
        <Image
          src={`data:image/png;base64,${block.source.data}`}
          alt="Screenshot"
          width={width}
          height={height}
          className="object-contain block"
        />
      </div>
    </div>
  );
}