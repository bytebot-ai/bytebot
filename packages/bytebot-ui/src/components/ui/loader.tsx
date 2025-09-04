import React from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

interface LoaderProps {
  size?: number;
  className?: string;
}

export const Loader: React.FC<LoaderProps> = ({ 
  size = 16, 
  className 
}) => {
  return (
    <Image
      src="/loader.svg"
      alt="Loading..."
      width={size}
      height={size}
      className={cn("animate-spin", className)}
    />
  );
}; 