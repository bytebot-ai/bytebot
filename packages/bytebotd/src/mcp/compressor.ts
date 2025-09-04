import * as sharp from 'sharp';

interface CompressionOptions {
  targetSizeKB?: number;
  initialQuality?: number;
  minQuality?: number;
  format?: 'png' | 'jpeg' | 'webp';
  maxIterations?: number;
}

interface CompressionResult {
  base64: string;
  sizeBytes: number;
  sizeKB: number;
  sizeMB: number;
  quality: number;
  format: string;
  iterations: number;
}

class Base64ImageCompressor {
  /**
   * Compress a base64 PNG string to under specified size (default 1MB)
   */
  static async compressToSize(
    base64String: string,
    options: CompressionOptions = {},
  ): Promise<CompressionResult> {
    const {
      targetSizeKB = 1024, // 1MB default
      initialQuality = 95,
      minQuality = 10,
      format = 'png',
      maxIterations = 10,
    } = options;

    // Extract base64 data (remove data URL prefix if present)
    const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
    const inputBuffer = Buffer.from(base64Data, 'base64');

    let quality = initialQuality;
    let outputBuffer: Buffer;
    let iterations = 0;

    // Binary search for optimal quality
    let low = minQuality;
    let high = initialQuality;
    let bestResult: { buffer: Buffer; quality: number } | null = null;

    while (low <= high && iterations < maxIterations) {
      quality = Math.floor((low + high) / 2);

      outputBuffer = await this.compressBuffer(inputBuffer, quality, format);
      const sizeKB = outputBuffer.length / 1024;

      if (sizeKB <= targetSizeKB) {
        // Size is acceptable, try higher quality
        bestResult = { buffer: outputBuffer, quality };
        low = quality + 1;
      } else {
        // Size too large, reduce quality
        high = quality - 1;
      }

      iterations++;
    }

    // If no result found under target size, use lowest quality
    if (!bestResult) {
      outputBuffer = await this.compressBuffer(inputBuffer, minQuality, format);
      quality = minQuality;
    } else {
      outputBuffer = bestResult.buffer;
      quality = bestResult.quality;
    }

    // Convert back to base64
    const outputBase64 = outputBuffer.toString('base64');
    const sizeBytes = outputBuffer.length;

    return {
      base64: outputBase64,
      sizeBytes,
      sizeKB: sizeBytes / 1024,
      sizeMB: sizeBytes / (1024 * 1024),
      quality,
      format,
      iterations,
    };
  }

  /**
   * Compress buffer with specified quality
   */
  private static async compressBuffer(
    inputBuffer: Buffer,
    quality: number,
    format: 'png' | 'jpeg' | 'webp',
  ): Promise<Buffer> {
    const sharpInstance = sharp(inputBuffer);

    switch (format) {
      case 'png':
        return sharpInstance
          .png({
            quality,
            compressionLevel: 9,
            adaptiveFiltering: true,
            palette: true,
          })
          .toBuffer();

      case 'jpeg':
        return sharpInstance
          .jpeg({
            quality,
            progressive: true,
            mozjpeg: true,
            optimizeScans: true,
          })
          .toBuffer();

      case 'webp':
        return sharpInstance
          .webp({
            quality,
            alphaQuality: quality,
            lossless: false,
            nearLossless: false,
            smartSubsample: true,
          })
          .toBuffer();

      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Compress with dimension reduction if quality alone isn't enough
   */
  static async compressWithResize(
    base64String: string,
    options: CompressionOptions & {
      maxWidth?: number;
      maxHeight?: number;
    } = {},
  ): Promise<CompressionResult> {
    const {
      targetSizeKB = 1024,
      maxWidth = 2048,
      maxHeight = 2048,
      ...compressionOptions
    } = options;

    // First try compression without resizing
    let result = await this.compressToSize(base64String, compressionOptions);

    // If still too large, apply progressive resizing
    if (result.sizeKB > targetSizeKB) {
      const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
      const inputBuffer = Buffer.from(base64Data, 'base64');

      const metadata = await sharp(inputBuffer).metadata();
      const originalWidth = metadata.width || maxWidth;
      const originalHeight = metadata.height || maxHeight;

      let scale = 0.9; // Start with 90% of original size

      while (result.sizeKB > targetSizeKB && scale > 0.3) {
        const newWidth = Math.floor(originalWidth * scale);
        const newHeight = Math.floor(originalHeight * scale);

        const resizedBuffer = await sharp(inputBuffer)
          .resize(newWidth, newHeight, {
            fit: 'inside',
            withoutEnlargement: true,
          })
          .toBuffer();

        const resizedBase64 = resizedBuffer.toString('base64');

        result = await this.compressToSize(resizedBase64, compressionOptions);
        scale -= 0.1;
      }
    }

    return result;
  }

  /**
   * Get size information for a base64 string
   */
  static getBase64SizeInfo(base64String: string): {
    bytes: number;
    kb: number;
    mb: number;
    formatted: string;
  } {
    const base64Data = base64String.replace(/^data:image\/\w+;base64,/, '');
    const bytes = Buffer.from(base64Data, 'base64').length;
    const kb = bytes / 1024;
    const mb = bytes / (1024 * 1024);

    let formatted: string;
    if (mb >= 1) {
      formatted = `${mb.toFixed(2)} MB`;
    } else if (kb >= 1) {
      formatted = `${kb.toFixed(2)} KB`;
    } else {
      formatted = `${bytes} bytes`;
    }

    return { bytes, kb, mb, formatted };
  }
}

// Utility function for quick compression
export async function compressPngBase64Under1MB(
  base64String: string,
): Promise<string> {
  const result = await Base64ImageCompressor.compressToSize(base64String, {
    targetSizeKB: 1024,
    format: 'png',
    initialQuality: 95,
    minQuality: 10,
  });

  return result.base64;
}

// Export the class for more control
export { Base64ImageCompressor, CompressionOptions, CompressionResult };
