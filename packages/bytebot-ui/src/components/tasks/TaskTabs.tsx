import React from "react";
import { TaskStatus } from "@/types";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Tick02Icon,
  CursorProgress04Icon,
  MultiplicationSignIcon,
  ListViewIcon,
} from "@hugeicons/core-free-icons";

type TabKey = "ALL" | "ACTIVE" | "COMPLETED" | "CANCELLED_FAILED";

interface TaskTabsProps {
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
  taskCounts: Record<TabKey, number>;
}

interface TabConfig {
  label: string;
  icon: any;
  color: string;
  statuses: TaskStatus[];
}

const TAB_CONFIGS: Record<TabKey, TabConfig> = {
  ALL: {
    label: "All",
    icon: ListViewIcon,
    color: "text-bytebot-bronze-light-10",
    statuses: Object.values(TaskStatus),
  },
  ACTIVE: {
    label: "Active",
    icon: CursorProgress04Icon,
    color: "text-bytebot-bronze-light-10",
    statuses: [TaskStatus.PENDING, TaskStatus.RUNNING, TaskStatus.NEEDS_HELP, TaskStatus.NEEDS_REVIEW],
  },
  COMPLETED: {
    label: "Completed",
    icon: Tick02Icon,
    color: "text-bytebot-bronze-light-10",
    statuses: [TaskStatus.COMPLETED],
  },
  CANCELLED_FAILED: {
    label: "Cancelled/Failed",
    icon: MultiplicationSignIcon,
    color: "text-bytebot-bronze-light-10",
    statuses: [TaskStatus.CANCELLED, TaskStatus.FAILED],
  },
};

export const TaskTabs: React.FC<TaskTabsProps> = ({
  activeTab,
  onTabChange,
  taskCounts,
}) => {
  const tabs = Object.entries(TAB_CONFIGS) as [TabKey, TabConfig][];

  return (
    <div className="border-b border-bytebot-bronze-light-7 mb-6">
      <div className="flex overflow-x-auto">
        {tabs.map(([tabKey, config]) => {
          const isActive = activeTab === tabKey;
          const count = taskCounts[tabKey] || 0;
          
          return (
            <button
              key={tabKey}
              onClick={() => onTabChange(tabKey)}
              className={`flex items-center space-x-2 px-4 py-3 border-b-2 transition-colors whitespace-nowrap cursor-pointer ${
                isActive
                  ? "border-bytebot-bronze-dark-7 text-bytebot-bronze-dark-7"
                  : "border-transparent text-bytebot-bronze-light-10 hover:text-bytebot-bronze-dark-7"
              }`}
            >
              <HugeiconsIcon
                icon={config.icon}
                className={`h-4 w-4 ${isActive ? "text-bytebot-bronze-dark-7" : config.color}`}
              />
              <span className="text-sm font-medium">{config.label}</span>
              {count > 0 && (
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    isActive
                      ? "bg-bytebot-bronze-dark-7 text-white"
                      : "bg-bytebot-bronze-light-7 text-bytebot-bronze-light-11"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

// Export the TabKey type and TAB_CONFIGS for use in other components
export type { TabKey };
export { TAB_CONFIGS };