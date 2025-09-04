import React from "react";
import Image from "next/image";
import { HugeiconsIcon } from "@hugeicons/react";
import { User03Icon } from "@hugeicons/core-free-icons";
import { Role } from "@/types";

interface MessageAvatarProps {
  role: Role;
}

export function MessageAvatar({ role }: MessageAvatarProps) {
  const baseClasses = "flex flex-shrink-0 items-center justify-center rounded-md border border-bytebot-bronze-light-7 bg-bytebot-bronze-light-1 h-[28px] w-[28px]";

  if (role === Role.ASSISTANT) {
    return (
      <div className={baseClasses}>
        <Image
          src="/bytebot_square_light.svg"
          alt="Bytebot"
          width={16}
          height={16}
          className="h-4 w-4"
        />
      </div>
    );
  }

  return (
    <div className={baseClasses}>
      <HugeiconsIcon
        icon={User03Icon}
        className="text-bytebot-bronze-dark-9 w-4 h-4"
      />
    </div>
  );
}