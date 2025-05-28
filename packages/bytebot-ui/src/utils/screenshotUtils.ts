import { Message } from "@/types";
import { isToolResultContentBlock, isImageContentBlock } from "@bytebot/shared";

export interface ScreenshotData {
  id: string;
  base64Data: string;
  messageIndex: number;
  blockIndex: number;
}

/**
 * Extracts all screenshots from messages
 */
export function extractScreenshots(messages: Message[]): ScreenshotData[] {
  const screenshots: ScreenshotData[] = [];
  
  messages.forEach((message, messageIndex) => {
    message.content.forEach((block, blockIndex) => {
      // Check if this is a tool result block with an image
      if (isToolResultContentBlock(block) && block.content && block.content.length > 0) {
        const imageBlock = block.content[0];
        if (isImageContentBlock(imageBlock)) {
          screenshots.push({
            id: `${message.id}-${blockIndex}`,
            base64Data: imageBlock.source.data,
            messageIndex,
            blockIndex,
          });
        }
      }
    });
  });
  
  return screenshots;
}

/**
 * Gets the screenshot that should be displayed based on scroll position
 */
export function getScreenshotForScrollPosition(
  screenshots: ScreenshotData[],
  messages: Message[],
  scrollContainer: HTMLElement | null
): ScreenshotData | null {
  if (!scrollContainer || screenshots.length === 0) {
    return screenshots[screenshots.length - 1] || null; // Default to last screenshot
  }

  // Get all message elements in the scroll container
  const messageElements = scrollContainer.querySelectorAll('[data-message-index]');
  
  if (messageElements.length === 0) {
    return screenshots[screenshots.length - 1] || null;
  }

  const containerScrollTop = scrollContainer.scrollTop;
  const containerHeight = scrollContainer.clientHeight;

  // Find the message that's most visible at 150px down from the top of the container
  const targetViewPosition = 150; // 150px down from top
  let bestVisibleMessageIndex = 0;
  let bestVisibility = 0;
  let minDistanceFromTarget = Infinity;

  messageElements.forEach((element) => {
    const messageIndex = parseInt((element as HTMLElement).dataset.messageIndex || '0');
    const elementTop = (element as HTMLElement).offsetTop;
    const elementHeight = (element as HTMLElement).offsetHeight;
    const elementBottom = elementTop + elementHeight;
    
    // Distance from top of container (accounting for scroll)
    const distanceFromViewportTop = elementTop - containerScrollTop;
    const distanceFromViewportBottom = elementBottom - containerScrollTop;
    
    // Check if element is visible in viewport
    const isVisible = distanceFromViewportTop < containerHeight && 
                     distanceFromViewportBottom > 0;
    
    if (isVisible) {
      // Calculate how much of this element is visible
      const visibleTop = Math.max(0, distanceFromViewportTop);
      const visibleBottom = Math.min(containerHeight, distanceFromViewportBottom);
      const visibleHeight = Math.max(0, visibleBottom - visibleTop);
      const visibility = visibleHeight / elementHeight;
      
      // Calculate distance from our target position (150px down)
      const elementCenter = distanceFromViewportTop + (elementHeight / 2);
      const distanceFromTarget = Math.abs(elementCenter - targetViewPosition);
      
      // Prefer elements that are closer to our target position and more visible
      if (visibility > 0.1 && // Must be at least 10% visible
          (distanceFromTarget < minDistanceFromTarget || 
           (distanceFromTarget === minDistanceFromTarget && visibility > bestVisibility))) {
        bestVisibility = visibility;
        bestVisibleMessageIndex = messageIndex;
        minDistanceFromTarget = distanceFromTarget;
      }
    }
  });

  // Find the most recent screenshot at or before this message index
  let bestScreenshot: ScreenshotData | null = null;
  for (const screenshot of screenshots) {
    if (screenshot.messageIndex <= bestVisibleMessageIndex) {
      bestScreenshot = screenshot;
    }
    // Don't break - we want to continue to find the best match
  }
  
  // If no screenshot found at or before this message, use the first screenshot
  if (!bestScreenshot && screenshots.length > 0) {
    bestScreenshot = screenshots[0];
  }
  
  return bestScreenshot || screenshots[0];
}