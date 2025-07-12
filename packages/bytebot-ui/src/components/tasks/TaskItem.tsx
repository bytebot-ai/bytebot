import React from "react";
import { Task, TaskStatus } from "@/types";
import { format } from "date-fns";
import { capitalizeFirstChar } from "@/utils/stringUtils";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Tick02Icon,
  CancelCircleIcon,
  Loading03Icon,
  MessageQuestionIcon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";

interface TaskItemProps {
  task: Task;
}

interface StatusIconConfig {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: any; // HugeIcons IconSvgObject type
  color?: string;
}

const STATUS_CONFIGS: Record<TaskStatus, StatusIconConfig> = {
  [TaskStatus.COMPLETED]: {
    icon: Tick02Icon,
    color: "bg-bytebot-green-3 border-bytebot-green-a5 text-bytebot-green-9",
  },
  [TaskStatus.RUNNING]: {
    icon: Loading03Icon,
    color: "border-orange-700 bg-orange-100 text-orange-900",
  },
  [TaskStatus.NEEDS_HELP]: {
    icon: MessageQuestionIcon,
    color: "border-blue-700 bg-blue-100 text-blue-900",
  },
  [TaskStatus.PENDING]: {
    icon: Loading03Icon,
    color: "border-yellow-700 bg-yellow-100 text-yellow-900",
  },
  [TaskStatus.FAILED]: {
    icon: CancelCircleIcon,
    color: "bg-bytebot-red-light-3 border-bytebot-red-light-7 text-bytebot-red-light-9",
  },
  [TaskStatus.NEEDS_REVIEW]: {
    icon: MessageQuestionIcon,
    color: "border-purple-700 bg-purple-100 text-purple-900",
  },
  [TaskStatus.CANCELLED]: {
    icon: CancelCircleIcon,
    color: "border-gray-700 bg-gray-100 text-gray-900",
  },
};

export const TaskItem: React.FC<TaskItemProps> = ({ task }) => {
  // Format date to match the screenshot (e.g., "Today 9:13am" or "April 13, 2025, 12:01pm")
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const today = new Date();

    const isToday = 
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear();

    const formatString = isToday 
      ? `'Today' h:mma`
      : "MMMM d, yyyy h:mma";

    const formatted = format(date, formatString).toLowerCase();
    return capitalizeFirstChar(formatted);
  };

  const StatusIcon = ({ status }: { status: TaskStatus }) => {
    const config = STATUS_CONFIGS[status];
    if (!config) return null;

    const { icon, color } = config;

    return (
      <div className="flex items-center justify-center">
        <HugeiconsIcon
          icon={icon}
          className={`h-4 w-4 ${color}`}
        />
      </div>
    );
  };

  return (
    <Link href={`/tasks/${task.id}`} className="block">
      <div className="shadow-bytebot bg-bytebot-bronze-light-2 border-bytebot-bronze-light-7 hover:bg-bytebot-bronze-light-3 flex min-h-24 items-start rounded-lg border-[0.5px] p-5 transition-colors">
        <div className="flex-1 space-y-2 mb-0.5">
          <div className="flex items-center justify-start space-x-2">
            <StatusIcon status={task.status} />
            <div className="text-byhtebot-bronze-dark-7 text-sm font-medium">
              {capitalizeFirstChar(task.description)}
            </div>
          </div>
          <div className="text-xs flex items-center justify-start space-x-1.5 ml-6">
            <span className="text-bytebot-bronze-light-10">
              {formatDate(task.createdAt)}
            </span>
            {task.user && (
              <>
                <span className="text-bytebot-bronze-light-10">
                  •
                </span>
                <span className="text-bytebot-bronze-light-10">
                  {task.user.name || task.user.email}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
};
