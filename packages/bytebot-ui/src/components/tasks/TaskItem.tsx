import React from "react";
import { Task, TaskStatus } from "@/types";
import { format } from "date-fns";
import { capitalizeFirstChar } from "@/utils/stringUtils";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Tick02Icon,
  Cancel01Icon,
  Loading03Icon,
  MessageQuestionIcon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";

interface TaskItemProps {
  task: Task;
}

export const TaskItem: React.FC<TaskItemProps> = ({ task }) => {
  // Format date to match the screenshot (e.g., "Today 9:13am" or "April 13, 2025, 12:01pm")
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const today = new Date();

    // Check if the date is today
    if (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    ) {
      const todayFormat = `Today ${format(date, "h:mma").toLowerCase()}`;
      return capitalizeFirstChar(todayFormat);
    }

    // Otherwise, return the full date
    const formattedDate = format(date, "MMMM d, yyyy, h:mma").toLowerCase();
    return capitalizeFirstChar(formattedDate);
  };

  return (
    <Link href={`/tasks/${task.id}`} className="block">
      <div className="shadow-bytebot bg-bytebot-bronze-light-2 border-bytebot-bronze-light-5 hover:bg-bytebot-bronze-light-3 flex min-h-24 items-start rounded-lg border-[0.5px] px-5 py-4 transition-colors">
        <div className="flex-1 space-y-1">
          <div className="text-byhtebot-bronze-dark-7 text-sm font-medium">
            {capitalizeFirstChar(task.description)}
          </div>
          <div className="text-byhtebot-bronze-dark-11 text-xs">
            {formatDate(task.createdAt)}
          </div>
          {task.status === TaskStatus.COMPLETED && (
            <div className="bg-bytebot-green-3 border-bytebot-green-a5 inline-flex w-fit items-center space-x-1 rounded-full border px-1.5 py-0.5">
              <HugeiconsIcon
                icon={Tick02Icon}
                className="text-bytebot-green-9 mr-1 h-4 w-4"
              />
              <span className="text-bytebot-green-11 text-[11px]">Success</span>
            </div>
          )}
          {task.status === TaskStatus.RUNNING && (
            <div className="inline-flex w-fit items-center space-x-1 rounded-full border border-orange-700 bg-orange-100 px-1.5 py-0.5">
              <HugeiconsIcon
                icon={Loading03Icon}
                className="mr-1 h-4 w-4 animate-[spin_3s_linear_infinite] text-orange-900"
              />
              <span className="text-[11px] text-orange-700">Running</span>
            </div>
          )}
          {task.status === TaskStatus.NEEDS_HELP && (
            <div className="inline-flex w-fit items-center space-x-1 rounded-full border border-blue-700 bg-blue-100 px-1.5 py-0.5">
              <HugeiconsIcon
                icon={MessageQuestionIcon}
                className="mr-1 h-4 w-4 text-blue-900"
              />
              <span className="text-[11px] text-blue-700">Needs Guidance</span>
            </div>
          )}
          {task.status === TaskStatus.PENDING && (
            <div className="inline-flex w-fit items-center space-x-1 rounded-full border border-yellow-700 bg-yellow-100 px-1.5 py-0.5">
              <HugeiconsIcon
                icon={Loading03Icon}
                className="mr-1 h-4 w-4 animate-[spin_3s_linear_infinite] text-yellow-900"
              />
              <span className="text-[11px] text-yellow-700">Pending</span>
            </div>
          )}
          {task.status === TaskStatus.FAILED && (
            <div className="bg-bytebot-red-light-3 border-bytebot-red-light-7 inline-flex w-fit items-center space-x-1 rounded-full border px-1.5 py-0.5">
              <HugeiconsIcon
                icon={Cancel01Icon}
                className="text-bytebot-red-light-9 mr-1 h-4 w-4"
              />
              <span className="text-bytebot-red-light-9 text-[11px]">
                Failed
              </span>
            </div>
          )}
        </div>
      </div>
    </Link>
  );
};
