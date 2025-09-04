"use client";

import React, { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { TaskItem } from "@/components/tasks/TaskItem";
import { TaskTabs, TabKey, TAB_CONFIGS } from "@/components/tasks/TaskTabs";
import { Pagination } from "@/components/ui/pagination";
import { fetchTasks, fetchTaskCounts } from "@/utils/taskUtils";
import { Task } from "@/types";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { Suspense } from "react";

function TasksPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Initialize activeTab from URL params
  const getInitialTab = (): TabKey => {
    const tabParam = searchParams.get("tab");
    if (tabParam && Object.keys(TAB_CONFIGS).includes(tabParam)) {
      return tabParam as TabKey;
    }
    return "ALL";
  };

  const [activeTab, setActiveTab] = useState<TabKey>(getInitialTab);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [taskCounts, setTaskCounts] = useState<Record<TabKey, number>>({
    ALL: 0,
    ACTIVE: 0,
    COMPLETED: 0,
    CANCELLED_FAILED: 0,
  });
  const PAGE_SIZE = 10;

  useEffect(() => {
    const loadTasks = async () => {
      setIsLoading(true);
      try {
        const statuses =
          activeTab === "ALL" ? undefined : TAB_CONFIGS[activeTab].statuses;
        const result = await fetchTasks({
          page: currentPage,
          limit: PAGE_SIZE,
          statuses,
        });
        setTasks(result.tasks);
        setTotal(result.total);
        setTotalPages(result.totalPages);
      } catch (error) {
        console.error("Failed to load tasks:", error);
      } finally {
        setIsLoading(false);
      }
    };

    loadTasks();
  }, [currentPage, activeTab]);

  useEffect(() => {
    const loadTaskCounts = async () => {
      try {
        const counts = await fetchTaskCounts();
        setTaskCounts(counts);
      } catch (error) {
        console.error("Failed to load task counts:", error);
      }
    };

    loadTaskCounts();
  }, []);

  // Sync activeTab with URL params when they change
  useEffect(() => {
    const tabParam = searchParams.get("tab");
    const newTab: TabKey =
      tabParam && Object.keys(TAB_CONFIGS).includes(tabParam)
        ? (tabParam as TabKey)
        : "ALL";

    if (newTab !== activeTab) {
      setActiveTab(newTab);
      setCurrentPage(1);
    }
  }, [searchParams, activeTab]);

  const handleTabChange = (tab: TabKey) => {
    setActiveTab(tab);
    setCurrentPage(1);

    // Update URL with the new tab
    const newSearchParams = new URLSearchParams(searchParams);
    if (tab === "ALL") {
      newSearchParams.delete("tab");
    } else {
      newSearchParams.set("tab", tab);
    }

    const newUrl = `/tasks${newSearchParams.toString() ? `?${newSearchParams.toString()}` : ""}`;
    router.push(newUrl, { scroll: false });
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />

      <main className="flex-1 overflow-scroll px-6 pt-6 pb-10">
        <div className="mx-auto max-w-3xl">
          <h1 className="mb-6 text-xl font-medium">Tasks</h1>

          {!isLoading && (
            <TaskTabs
              activeTab={activeTab}
              onTabChange={handleTabChange}
              taskCounts={taskCounts}
            />
          )}

          {isLoading ? (
            <div className="p-8 text-center">
              <div className="border-bytebot-bronze-light-5 border-t-bytebot-bronze mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4"></div>
              <p className="text-gray-500">Loading tasks...</p>
            </div>
          ) : tasks.length === 0 ? (
            <div className="bg-bytebot-bronze-light-2 border-bytebot-bronze-light-7 rounded-xl border p-8 text-center">
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
            <>
              <div className="space-y-4">
                {tasks.map((task) => (
                  <TaskItem key={task.id} task={task} />
                ))}
              </div>

              {totalPages > 1 && (
                <Pagination
                  currentPage={currentPage}
                  totalPages={totalPages}
                  onPageChange={handlePageChange}
                  total={total}
                  pageSize={PAGE_SIZE}
                />
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function TasksPageFallback() {
  return (
    <div className="p-8 text-center">
      <div className="border-bytebot-bronze-light-5 border-t-bytebot-bronze mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4"></div>
      <p className="text-gray-500">Loading tasks...</p>
    </div>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={<TasksPageFallback />}>
      <TasksPageContent />
    </Suspense>
  );
}
