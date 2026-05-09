interface OTPEntry {
  otp: string;
  expiresAt: number;
}

const store = new Map<string, OTPEntry>();
const verifiedEmails = new Set<string>();

export function saveOTP(email: string, otp: string): void {
  store.set(email.toLowerCase(), {
    otp,
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
}

export function verifyOTP(email: string, inputOtp: string): boolean {
  const key = email.toLowerCase();
  const entry = store.get(key);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return false;
  }
  if (entry.otp !== inputOtp) return false;
  store.delete(key);
  verifiedEmails.add(key);
  return true;
}

export function isEmailVerified(email: string): boolean {
  return verifiedEmails.has(email.toLowerCase());
}

export function clearVerifiedEmail(email: string): void {
  verifiedEmails.delete(email.toLowerCase());
}
