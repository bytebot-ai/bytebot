import { useState, useEffect, useCallback, useRef } from 'react';
import { Message } from '@/types';
import { extractScreenshots, getScreenshotForScrollPosition, ScreenshotData } from '@/utils/screenshotUtils';

interface UseScrollScreenshotProps {
  messages: Message[];
  scrollContainerRef: React.RefObject<HTMLElement | null>;
}

export function useScrollScreenshot({ messages, scrollContainerRef }: UseScrollScreenshotProps) {
  const [currentScreenshot, setCurrentScreenshot] = useState<ScreenshotData | null>(null);
  const [allScreenshots, setAllScreenshots] = useState<ScreenshotData[]>([]);
  const lastScrollTime = useRef<number>(0);

  // Extract screenshots whenever messages change
  useEffect(() => {
    const screenshots = extractScreenshots(messages);
    setAllScreenshots(screenshots);
    
    // Set initial screenshot (latest one) with a small delay to ensure container is ready
    if (screenshots.length > 0) {
      setTimeout(() => {
        const initialScreenshot = getScreenshotForScrollPosition(
          screenshots,
          messages,
          scrollContainerRef.current
        );
        setCurrentScreenshot(initialScreenshot);
      }, 100);
    } else {
      setCurrentScreenshot(null);
    }
  }, [messages, scrollContainerRef]);

  // Store the actual scrolling element
  const actualScrollElementRef = useRef<HTMLElement | null>(null);

  // Handle scroll events to update current screenshot
  const handleScroll = useCallback((scrollElement?: HTMLElement) => {
    if (allScreenshots.length === 0) return;

    const now = Date.now();
    lastScrollTime.current = now;

    setTimeout(() => {
      if ((Date.now() - now) <= 150 && allScreenshots.length > 0) {
        const scrollContainer = scrollElement || actualScrollElementRef.current || scrollContainerRef.current;
        const screenshot = getScreenshotForScrollPosition(allScreenshots, messages, scrollContainer);
        
        // Only update if screenshot actually changed
        if (screenshot?.id !== currentScreenshot?.id) {
          setCurrentScreenshot(screenshot);
        }
      }
    }, 50);
  }, [allScreenshots, messages, scrollContainerRef, currentScreenshot]);

  // Attach scroll listener
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const scrollHandler = (e: Event) => {
      const scrollElement = e.target as HTMLElement;
      actualScrollElementRef.current = scrollElement;
      handleScroll(scrollElement);
    };

    const cleanupFunctions: (() => void)[] = [];

    // Attach to container and all scrollable child/parent elements
    [container, ...container.querySelectorAll('*')].forEach((element) => {
      const style = getComputedStyle(element);
      const hasScroll = element.scrollHeight > element.clientHeight;
      const hasOverflow = ['auto', 'scroll'].includes(style.overflow) || ['auto', 'scroll'].includes(style.overflowY);
      
      if (hasScroll || hasOverflow) {
        element.addEventListener('scroll', scrollHandler, { passive: true });
        cleanupFunctions.push(() => element.removeEventListener('scroll', scrollHandler));
      }
    });

    // Also check parent elements
    let parent = container.parentElement;
    let level = 0;
    while (parent && level < 3) {
      const style = getComputedStyle(parent);
      if (parent.scrollHeight > parent.clientHeight || ['auto', 'scroll'].includes(style.overflow) || ['auto', 'scroll'].includes(style.overflowY)) {
        parent.addEventListener('scroll', scrollHandler, { passive: true });
        cleanupFunctions.push(() => parent?.removeEventListener('scroll', scrollHandler));
      }
      parent = parent.parentElement;
      level++;
    }
    
    return () => cleanupFunctions.forEach(cleanup => cleanup());
  }, [handleScroll, scrollContainerRef]);

  return {
    currentScreenshot,
    allScreenshots,
    hasScreenshots: allScreenshots.length > 0,
  };
}