import React from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

// Status types based on the image
export type VirtualDesktopStatus =
  | "running"
  | "needs_attention"
  | "failed"
  | "canceled"
  | "pending"
  | "user_control"
  | "completed"
  | "live_view";

interface StatusConfig {
  dot: React.ReactNode;
  text: string;
  gradient: string;
  subtext: string;
}

const statusConfig: Record<VirtualDesktopStatus, StatusConfig> = {
  live_view: {
    dot: (
      <span className="flex items-center justify-center">
        <Image
          src="/indicators/indicator-black.svg"
          alt="Live view status"
          width={15}
          height={15}
        />
      </span>
    ),
    text: "Live Desktop View",
    gradient: "from-gray-700 to-gray-900",
    subtext: "",
  },
  running: {
    dot: (
      <span className="flex items-center justify-center">
        <Image
          src="/indicators/indicator-green.svg"
          alt="Running status"
          width={15}
          height={15}
        />
      </span>
    ),
    text: "Running",
    gradient: "from-green-700 to-green-900",
    subtext: "Task in progress",
  },
  needs_attention: {
    dot: (
      <span className="flex items-center justify-center">
        <Image
          src="/indicators/indicator-orange.svg"
          alt="Needs attention status"
          width={15}
          height={15}
        />
      </span>
    ),
    text: "Needs Attention",
    gradient: "from-yellow-600 to-orange-700",
    subtext: "Task needs attention",
  },
  failed: {
    dot: (
      <span className="flex items-center justify-center">
        <Image
          src="/indicators/indicator-red.svg"
          alt="Failed status"
          width={15}
          height={15}
        />
      </span>
    ),
    text: "Failed",
    gradient: "from-red-700 to-red-900",
    subtext: "Task failed",
  },
  canceled: {
    dot: (
      <span className="flex items-center justify-center">
        <Image
          src="/indicators/indicator-gray.svg"
          alt="Canceled status"
          width={15}
          height={15}
        />
      </span>
    ),
    text: "Canceled",
    gradient: "from-gray-400 to-gray-600",
    subtext: "Task canceled",
  },
  pending: {
    dot: (
      <span className="flex items-center justify-center">
        <Image
          src="/indicators/indicator-gray.svg"
          alt="Pending status"
          width={15}
          height={15}
        />
      </span>
    ),
    text: "Pending",
    gradient: "from-gray-400 to-gray-600",
    subtext: "Task pending",
  },
  user_control: {
    dot: (
      <span className="flex items-center justify-center">
        <Image
          src="/indicators/indicator-pink.svg"
          alt="User control status"
          width={15}
          height={15}
        />
      </span>
    ),
    text: "Running",
    gradient: "from-pink-500 to-fuchsia-700",
    subtext: "You took control",
  },
  completed: {
    dot: (
      <span className="flex items-center justify-center">
        <Image
          src="/indicators/indicator-green.svg"
          alt="Completed status"
          width={15}
          height={15}
        />
      </span>
    ),
    text: "Completed",
    gradient: "from-green-700 to-green-900",
    subtext: "Task completed",
  },
};

export interface VirtualDesktopStatusHeaderProps {
  status: VirtualDesktopStatus;
  subtext?: string; // allow override
  className?: string;
}

export const VirtualDesktopStatusHeader: React.FC<
  VirtualDesktopStatusHeaderProps
> = ({ status, subtext, className }) => {
  const config = statusConfig[status];
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <span className="mt-1 flex items-center justify-center">
        {config.dot}
      </span>
      <div>
        <span
          className={cn(
            "text-md text-base font-semibold",
            config.gradient ? "bg-clip-text text-transparent" : "text-zinc-600",
          )}
          style={
            config.gradient
              ? {
                  backgroundImage: `linear-gradient(to right, var(--tw-gradient-stops))`,
                }
              : undefined
          }
        >
          <span
            className={cn(
              config.gradient
                ? `bg-gradient-to-r ${config.gradient} bg-clip-text text-transparent`
                : "",
            )}
          >
            {config.text}
          </span>
        </span>
        {config.subtext && (
          <span className="block text-[12px] text-zinc-400">
            {subtext || config.subtext}
          </span>
        )}
      </div>
    </div>
  );
};
