import { supabase } from "../lib/supabase.js";

const BUCKET = "skinscan-images";

export async function uploadImage(
  buffer: Buffer,
  path: string,
): Promise<string> {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: "image/jpeg", upsert: true });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

export async function deleteImage(path: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) throw new Error(`Storage delete failed: ${error.message}`);
}

export function getPathFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split(`/${BUCKET}/`);
    return parts[1] ?? null;
  } catch {
    return null;
  }
}
