import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    env: {
      SUPABASE_URL: "https://mock.supabase.co",
      SUPABASE_SERVICE_KEY: "mock-key",
      JWT_SECRET: "mock-jwt",
      JWT_REFRESH_SECRET: "mock-refresh",
      GMAIL_USER: "test@example.com",
      GMAIL_PASS: "mock",
      FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"mock"}',
      RAZORPAY_KEY_ID: "mock_key_id",
      RAZORPAY_SECRET: "mock_secret"
    }
  }
});
