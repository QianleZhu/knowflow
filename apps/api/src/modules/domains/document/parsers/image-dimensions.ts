// 图片格式与尺寸识别统一交给 image-size，覆盖 WebP 等格式。
import { imageSize } from "image-size";

// 从文件内容读取尺寸；损坏或未知格式保持原有未知尺寸兜底。
export function readImageDimensions(buffer: Buffer): {
  width: number | null;
  height: number | null;
} {
  try {
    const { width, height } = imageSize(buffer);
    return { width, height };
  } catch {
    return { width: null, height: null };
  }
}
