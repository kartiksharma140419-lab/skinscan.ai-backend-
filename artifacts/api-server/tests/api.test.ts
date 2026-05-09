import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app.js";
import { calculatePercentile } from "../src/utils/percentile.js";

import jwt from "jsonwebtoken";
// We can import the mocked db from setup.ts by overriding typescript compilation rules
// The mocked db is exposed on globalThis via setup.ts
const mockDb = (globalThis as any).mockDb;

describe("Backend API Integration Tests", () => {
  beforeEach(() => {
    mockDb.otp_codes = [];
    mockDb.users = [];
    mockDb.scan_history = [];
  });

  describe("TEST 1 - OTP AUTHENTICATION FLOW", () => {
    it("should generate, persist, verify OTP and return JWT", async () => {
      const email = "test-otp@example.com";

      // 1. Send OTP
      const sendRes = await request(app)
        .post("/api/auth/send-otp")
        .send({ email });
      expect(sendRes.status).toBe(200);

      // 2. Query otp_codes table directly from the mock
      const otpRow = mockDb.otp_codes.find((row: any) => row.email === email);
      expect(otpRow).toBeDefined();
      expect(otpRow.used).toBe(false);

      const generatedOtp = otpRow.otp;

      // 3. Submit correct OTP
      const verifyRes = await request(app)
        .post("/api/auth/verify-otp")
        .send({ email, otp: generatedOtp });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);

      // Confirm otp row is marked used=true BEFORE calling login which clears it
      const updatedOtpRow = mockDb.otp_codes.find((row: any) => row.email === email && row.otp === generatedOtp);
      expect(updatedOtpRow.used).toBe(true);

      // 4. In this new flow, we must call /login to get the JWT
      // Let's seed the user first so login succeeds
      mockDb.users.push({ id: "123", email, name: "Test User", is_subscribed: false });
      
      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({ email });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body.access_token).toBeDefined();

      // 6. Confirm submitting the same OTP again returns an error
      const retryRes = await request(app)
        .post("/api/auth/verify-otp")
        .send({ email, otp: generatedOtp });
      expect(retryRes.status).toBe(401);
      expect(retryRes.body.message).toMatch(/Invalid or expired OTP/i);
    });

    it("should reject expired OTPs", async () => {
      const email = "expired@example.com";
      const otp = "123456";
      
      // Manually insert expired OTP
      mockDb.otp_codes.push({
        email,
        otp,
        used: false,
        expires_at: new Date(Date.now() - 10000).toISOString() // Past
      });

      const res = await request(app)
        .post("/api/auth/verify-otp")
        .send({ email, otp });
      
      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/Invalid or expired OTP/i);
    });
  });

  describe("TEST 2 - GOOGLE AUTH FLOW", () => {
    it("should return valid session for Google ID token", async () => {
      // The setup.ts already mocks verifyIdToken to return mock@google.com
      const res = await request(app)
        .post("/api/auth/google")
        .send({ id_token: "fake-token" });

      expect(res.status).toBe(200);
      expect(res.body.access_token).toBeDefined();
      expect(res.body.user.name).toBe("MOCK GOOGLE USER"); // The auth route transforms name to uppercase

      // Confirm user is created in the db
      const user = mockDb.users.find((u: any) => u.email === "mock@google.com");
      expect(user).toBeDefined();
      expect(user.name).toBe("MOCK GOOGLE USER");
    });
  });

  describe("TEST 5 - PERCENTILE QUERY", () => {
    it("should return correct percentile based on seeds", async () => {
      const userId = "test-user-id";
      
      // Mock user authentication
      // In this test, we skip standard auth and just directly call the endpoint logic,
      const token = jwt.sign({ user_id: userId, email: "u@u.com" }, "mock-jwt");

      // Seed users
      mockDb.users = [
        { id: userId, age: 25 },
        { id: "u1", age: 24 },
        { id: "u2", age: 26 },
        { id: "u3", age: 30 } // Out of +/- 2 year age range
      ];

      // Seed scan history
      mockDb.scan_history = [
        { user_id: userId, scan_type: "face", score: 5 }, // Test user
        { user_id: "u1", scan_type: "face", score: 4 }, // Worse
        { user_id: "u2", scan_type: "face", score: 6 }, // Better
        { user_id: "u3", scan_type: "face", score: 2 } // Out of age range, shouldn't count
      ];

      const percentile = await calculatePercentile(25, "face", 5);
      
      // The population is u1, u2. Total = 2.
      // u1 score (4) < test score (5). Count = 1.
      // Percentile = (1 / 2) * 100 = 50.
      expect(percentile).toBe(50);
    });
  });

  describe("TEST 6 - PREFERENCES SAVE + FETCH", () => {
    it("should save and retrieve notifications_enabled correctly", async () => {
      const userId = "prefs-user";
      const token = jwt.sign({ user_id: userId, email: "u@u.com" }, "mock-jwt");

      mockDb.users.push({ id: userId, email: "u@u.com", notifications_enabled: true });

      // 1. PATCH preferences
      const patchRes = await request(app)
        .patch("/api/user/preferences")
        .set("Authorization", `Bearer ${token}`)
        .send({ notifications_enabled: false });
      
      expect(patchRes.status).toBe(200);

      // 2. GET profile
      const getRes = await request(app)
        .get("/api/user/profile")
        .set("Authorization", `Bearer ${token}`);
      
      expect(getRes.status).toBe(200);
      expect(getRes.body.notifications_enabled).toBe(false);
    });
  });
});
