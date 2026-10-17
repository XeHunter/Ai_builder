export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_BYTES = 5 * 1024 * 1024;

/** Client-side checks mirroring the server limits. Returns an error message or null when the file is fine. */
export function validateImageFile(file: Pick<File, "type" | "size" | "name">): string | null {
  if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
    return `“${file.name}” is not a supported image. Use a JPEG, PNG or WebP photo.`;
  }
  if (file.size === 0) return `“${file.name}” is empty.`;
  if (file.size > MAX_BYTES) {
    return `“${file.name}” is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`;
  }
  return null;
}
