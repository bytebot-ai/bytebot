import * as sharp from 'sharp';

/**
 * Creates a cursor image as a Buffer.
 * The cursor is a simple arrow pointer shape.
 */
export async function createCursorImage(
  size: number = 24,
  color: string = '#000000',
  outlineColor: string = '#FFFFFF',
): Promise<Buffer> {
  // Create a simple arrow cursor SVG
  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <!-- White outline for visibility on dark backgrounds -->
      <path d="M 2 2 L 2 20 L 7 15 L 12 22 L 15 20 L 10 13 L 17 13 Z"
            fill="none"
            stroke="${outlineColor}"
            stroke-width="2"
            stroke-linejoin="round"/>
      <!-- Black fill -->
      <path d="M 2 2 L 2 20 L 7 15 L 12 22 L 15 20 L 10 13 L 17 13 Z"
            fill="${color}"/>
    </svg>
  `;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Overlays a cursor image onto a screenshot at the specified position.
 *
 * @param screenshotBuffer The screenshot image buffer
 * @param cursorX The x coordinate of the cursor
 * @param cursorY The y coordinate of the cursor
 * @param cursorSize The size of the cursor (default 24)
 * @returns A Buffer containing the screenshot with cursor overlay
 */
export async function overlayeCursorOnScreenshot(
  screenshotBuffer: Buffer,
  cursorX: number,
  cursorY: number,
  cursorSize: number = 24,
): Promise<Buffer> {
  // Create the cursor image
  const cursorBuffer = await createCursorImage(cursorSize);

  // Get screenshot metadata to ensure cursor stays within bounds
  const metadata = await sharp(screenshotBuffer).metadata();
  const width = metadata.width || 1920;
  const height = metadata.height || 1080;

  // Ensure cursor position is within screenshot bounds
  const safeX = Math.max(0, Math.min(cursorX, width - 1));
  const safeY = Math.max(0, Math.min(cursorY, height - 1));

  // Composite the cursor onto the screenshot
  return sharp(screenshotBuffer)
    .composite([
      {
        input: cursorBuffer,
        left: Math.round(safeX),
        top: Math.round(safeY),
      },
    ])
    .png()
    .toBuffer();
}
