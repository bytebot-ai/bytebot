"use client";

import React, { useEffect, useState } from "react";
import { Header } from "@/components/layout/Header";
import { TaskItem } from "@/components/tasks/TaskItem";
import { fetchTasks } from "@/utils/taskUtils";
import { Task } from "@/types";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export default function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadTasks = async () => {
      setIsLoading(true);
      try {
        const fetchedTasks = await fetchTasks();
        setTasks(fetchedTasks);
      } catch (error) {
        console.error("Failed to load tasks:", error);
      } finally {
        setIsLoading(false);
      }
    };

    loadTasks();
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />

      <main className="flex-1 overflow-scroll px-6 pt-6 pb-10">
        <div className="mx-auto max-w-3xl">
          <h1 className="mb-6 text-xl font-medium">Tasks</h1>

          {isLoading ? (
            <div className="p-8 text-center">
              <div className="border-bytebot-bronze-light-5 border-t-bytebot-bronze mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4"></div>
              <p className="text-gray-500">Loading tasks...</p>
            </div>
          ) : tasks.length === 0 ? (
            <div className="bg-bytebot-bronze-light-2 border-bytebot-bronze-light-7 shadow-bytebot rounded-xl border p-8 text-center">
              <div className="flex flex-col items-center justify-center">
                <h3 className="text-bytebot-bronze-light-12 mb-1 text-lg font-medium">
                  No tasks yet
                </h3>
                <p className="text-bytebot-bronze-light-11 mb-6 text-sm">
                  Get started by creating a first task
                </p>
                <Link href="/">
                  <Button className="bg-bytebot-bronze-dark-7 hover:bg-bytebot-bronze-dark-6 text-white">
                    + New Task
                  </Button>
                </Link>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {tasks.map((task) => (
                <TaskItem key={task.id} task={task} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
