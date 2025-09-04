"use client";

import React, { useEffect, useRef, ReactElement } from "react";

interface TopicPopoverProps {
  children: React.ReactNode;
  onOpenChange?: (isOpen: boolean) => void;
  isActive?: boolean;
}

export const TopicPopover: React.FC<TopicPopoverProps> = ({
  children,
  onOpenChange,
  isActive = false,
}) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Sync with parent's active state
  useEffect(() => {
    setIsOpen(isActive);
  }, [isActive]);

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        if (onOpenChange) {
          onOpenChange(false);
        }
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen, onOpenChange]);

  const handleToggle = () => {
    const newState = !isOpen;
    setIsOpen(newState);
    if (onOpenChange) {
      onOpenChange(newState);
    }
  };

  // Create a modified version of the button with updated text color
  const modifiedChildren = React.Children.map(children, (child) => {
    // Only process React elements (not strings, numbers, etc.)
    if (!React.isValidElement(child)) return child;
    
    // Cast to ReactElement to access props properly
    const element = child as ReactElement<{ className?: string }>;
    
    // Get the existing className
    const existingClassName = element.props.className || '';
    
    // Replace text-bytebot-bronze-light-11 with text-bytebot-bronze-light-12 when open
    const updatedClassName = isOpen 
      ? existingClassName.replace('text-bytebot-bronze-light-11', 'text-bytebot-bronze-light-12')
      : existingClassName;
    
    // Clone the element with the updated className
    return React.cloneElement(element, {
      ...element.props,
      className: updatedClassName
    });
  });

  return (
    <div className="relative" ref={popoverRef}>
      <div onClick={handleToggle} className={isOpen ? "bg-bytebot-bronze-light-1 rounded-full" : ""}>
        {modifiedChildren}
      </div>
    </div>
  );
};
