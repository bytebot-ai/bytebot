import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-bronze-light-10 placeholder:text-bronze-light-7 selection:bg-blue-light-6 selection:text-bronze-light-1 border-bronze-light-4 flex h-9 w-full min-w-0 rounded-md border bg-bronze-light-1 px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-blue-light-5 focus-visible:ring-blue-light-5/30 focus-visible:ring-[3px]",
        "aria-invalid:ring-red-light-6/20 dark:aria-invalid:ring-red-light-6/40 aria-invalid:border-red-light-6",
        className
      )}
      {...props}
    />
  )
}

export { Input }
