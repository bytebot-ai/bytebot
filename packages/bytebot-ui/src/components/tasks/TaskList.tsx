"use client";

import React, { useEffect, useState, useCallback } from "react";
import { TaskItem } from "@/components/tasks/TaskItem";
import { fetchTasks } from "@/utils/taskUtils";
import { Task } from "@/types";
import { useWebSocket } from "@/hooks/useWebSocket";

interface TaskListProps {
  limit?: number;
  className?: string;
  title?: string;
  description?: string;
  showHeader?: boolean;
}

export const TaskList: React.FC<TaskListProps> = ({ 
  limit = 5, 
  className = "", 
  title = "Latest Tasks",
  description,
  showHeader = true,
}) => {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // WebSocket handlers for real-time updates
  const handleTaskUpdate = useCallback((updatedTask: Task) => {
    setTasks(prev => 
      prev.map(task => 
        task.id === updatedTask.id ? updatedTask : task
      )
    );
  }, []);

  const handleTaskCreated = useCallback((newTask: Task) => {
    setTasks(prev => {
      const updated = [newTask, ...prev];
      return updated.slice(0, limit);
    });
  }, [limit]);

  const handleTaskDeleted = useCallback((taskId: string) => {
    setTasks(prev => prev.filter(task => task.id !== taskId));
  }, []);

  // Initialize WebSocket for task list updates
  useWebSocket({
    onTaskUpdate: handleTaskUpdate,
    onTaskCreated: handleTaskCreated,
    onTaskDeleted: handleTaskDeleted,
  });

  useEffect(() => {
    const loadTasks = async () => {
      setIsLoading(true);
      try {
        const result = await fetchTasks({ limit });
        setTasks(result.tasks);
      } catch (error) {
        console.error("Failed to load tasks:", error);
      } finally {
        setIsLoading(false);
      }
    };

    loadTasks();
  }, [limit]);

  return (
    <div className={className}>
      {showHeader && (
        <div className="mb-6 flex flex-col gap-1">
          <h2 className="text-base font-medium">{title}</h2>
          <p className="text-sm text-bytebot-bronze-light-11">{description}</p>
        </div>
      )}
      
      {isLoading ? (
        <div className="p-4 text-center">
          <div className="animate-spin h-6 w-6 border-4 border-bytebot-bronze-light-5 border-t-bytebot-bronze rounded-full mx-auto mb-2"></div>
          <p className="text-gray-500 text-sm">Loading tasks...</p>
        </div>
      ) : tasks.length === 0 ? (
        <div className="p-4 text-center border border-dashed border-bytebot-bronze-light-5 rounded-lg">
          <p className="text-gray-500 text-sm">No tasks available</p>
          <p className="text-gray-400 text-xs mt-1">Your completed tasks will appear here</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <TaskItem key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
};
