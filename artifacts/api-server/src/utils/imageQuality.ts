export function validateImage(
  file: Express.Multer.File,
): { valid: boolean; error?: string } {
  const allowedMimes = ["image/jpeg", "image/png", "image/webp", "image/heic"];
  if (!allowedMimes.includes(file.mimetype)) {
    return { valid: false, error: "Only JPEG, PNG, WebP or HEIC images are allowed" };
  }
  if (file.size > 5 * 1024 * 1024) {
    return { valid: false, error: "Image must be smaller than 5MB" };
  }
  return { valid: true };
}
