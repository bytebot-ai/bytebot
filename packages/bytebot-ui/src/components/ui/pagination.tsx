import React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon, ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { Button } from "./button";

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  total: number;
  pageSize: number;
}

export const Pagination: React.FC<PaginationProps> = ({
  currentPage,
  totalPages,
  onPageChange,
  total,
  pageSize,
}) => {
  if (totalPages <= 1) return null;

  const startItem = (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, total);

  const getVisiblePages = () => {
    const delta = 2;
    const range = [];
    const rangeWithDots = [];

    for (
      let i = Math.max(2, currentPage - delta);
      i <= Math.min(totalPages - 1, currentPage + delta);
      i++
    ) {
      range.push(i);
    }

    if (currentPage - delta > 2) {
      rangeWithDots.push(1, "...");
    } else {
      rangeWithDots.push(1);
    }

    rangeWithDots.push(...range);

    if (currentPage + delta < totalPages - 1) {
      rangeWithDots.push("...", totalPages);
    } else {
      rangeWithDots.push(totalPages);
    }

    return rangeWithDots;
  };

  const visiblePages = getVisiblePages();

  return (
    <div className="flex items-center justify-between border-t border-bytebot-bronze-light-7 pt-6">
      <div className="flex items-center text-sm text-bytebot-bronze-light-11">
        Showing {startItem} to {endItem} of {total} results
      </div>
      
      <div className="flex items-center space-x-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="flex items-center space-x-1"
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} className="h-4 w-4" />
          <span>Previous</span>
        </Button>

        <div className="flex items-center space-x-1">
          {visiblePages.map((page, index) => {
            if (page === "...") {
              return (
                <span
                  key={`ellipsis-${index}`}
                  className="px-3 py-2 text-sm text-bytebot-bronze-light-11"
                >
                  ...
                </span>
              );
            }

            const pageNum = page as number;
            const isCurrentPage = pageNum === currentPage;

            return (
              <Button
                key={pageNum}
                variant={isCurrentPage ? "default" : "outline"}
                size="sm"
                onClick={() => onPageChange(pageNum)}
                className={`min-w-[40px] ${
                  isCurrentPage
                    ? "bg-bytebot-bronze-dark-7 text-white"
                    : "text-bytebot-bronze-light-11 hover:text-bytebot-bronze-dark-7"
                }`}
              >
                {pageNum}
              </Button>
            );
          })}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="flex items-center space-x-1"
        >
          <span>Next</span>
          <HugeiconsIcon icon={ArrowRight02Icon} className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};