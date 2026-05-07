# SkinScan AI — Backend

An AI-powered skin and hair fall tracker API for India. Analyzes face/scalp photos using Gemini AI, tracks daily care routines, manages subscriptions via Razorpay, and sends push notifications via Firebase.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, proxied at `/api`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Database: Supabase (PostgreSQL) via `@supabase/supabase-js`
- Image storage: Supabase Storage (`skinscan-images` bucket)
- AI: Google Gemini 1.5 Flash (`@google/generative-ai`)
- Auth: Firebase Admin SDK (OTP verify) + JWT (access 15min, refresh 30d)
- Payments: Razorpay (`razorpay`)
- Image processing: `sharp` (resize to 1024px, JPEG 85%)
- File upload: `multer` (memory storage, 5MB limit)
- Push notifications: Firebase Cloud Messaging
- Validation: `zod`
- Scheduled jobs: `node-cron`

## Where things live

```
artifacts/api-server/src/
  app.ts                      # Express setup, CORS, route mounting, cron start
  index.ts                    # Port binding
  lib/
    supabase.ts               # Supabase client singleton
    logger.ts                 # Pino logger
  middleware/
    auth.ts                   # JWT verify middleware (requireAuth)
    upload.ts                 # Multer memory-storage config (5MB)
  routes/
    auth.ts                   # /api/auth/* — OTP, register, login, refresh
    user.ts                   # /api/user/* — dashboard, profile, prefs, history
    scan.ts                   # /api/scan/* — AI photo analysis, scan results
    tracker.ts                # /api/tracker/* — daily tasks, completion, history
    payment.ts                # /api/payment/* — Razorpay orders, verify, status
  services/
    ai.ts                     # Gemini 1.5 Flash call + JSON parser
    storage.ts                # Supabase Storage upload/delete/URL helpers
    firebase.ts               # Firebase Admin init + verifyIdToken
    notifications.ts          # FCM sendPush helper
    remedies.ts               # 90+ remedy/task library + personalisation logic
    cron.ts                   # Scheduled jobs (reminders, cleanup, sub expiry)
  utils/
    percentile.ts             # Score percentile vs age group
    imageQuality.ts           # MIME + size validation
```

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/send-otp | — | Confirm OTP will be sent via Firebase |
| POST | /api/auth/register | — | Verify Firebase ID token, create user, return JWT pair |
| POST | /api/auth/login | — | Verify Firebase ID token, return JWT pair |
| POST | /api/auth/refresh | — | Exchange refresh token for new access token |
| GET | /api/user/dashboard | ✓ | Last scans, tracker %, streak, seasonal banner |
| GET | /api/user/profile | ✓ | Full user object |
| PATCH | /api/user/preferences | ✓ | Update language, reminder_time, fcm_token |
| GET | /api/user/scan-history | ✓ | All scans DESC |
| DELETE | /api/user/photos | ✓ | Delete all scan photos from storage |
| POST | /api/scan/analyze | ✓ | Upload photo → Gemini AI → score + remedies |
| GET | /api/scan/result/:id | ✓ | Fetch a single scan result |
| GET | /api/tracker/today | ✓ | Generate/return today's tasks |
| PATCH | /api/tracker/task/:id/complete | ✓ | Mark task done, update streak |
| GET | /api/tracker/history | ✓ | 8-week score chart data |
| GET | /api/tracker/comparison-photos | ✓ | First vs latest scan photo |
| POST | /api/payment/create-order | ✓ | Create Razorpay order |
| POST | /api/payment/verify | ✓ | Verify HMAC signature, activate subscription |
| GET | /api/payment/status | ✓ | Current subscription status |

## Database Schema (run in Supabase SQL editor)

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE TYPE skin_type_enum AS ENUM ('oily','dry','combination','normal');
CREATE TYPE hair_type_enum AS ENUM ('straight','wavy','curly','coily');
CREATE TYPE concern_enum AS ENUM ('skin','hair','both');
CREATE TYPE severity_enum AS ENUM ('mild','moderate','serious');
CREATE TYPE scan_type_enum AS ENUM ('face','hair');
CREATE TYPE payment_status_enum AS ENUM ('created','paid','failed');
CREATE TYPE plan_enum AS ENUM ('monthly','yearly');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(15) UNIQUE,
  email VARCHAR(255),
  name VARCHAR(100) NOT NULL,
  age INTEGER,
  skin_type skin_type_enum,
  hair_type hair_type_enum,
  concern concern_enum DEFAULT 'both',
  language VARCHAR(5) DEFAULT 'en',
  reminder_time TIME DEFAULT '08:00',
  is_subscribed BOOLEAN DEFAULT false,
  sub_expires TIMESTAMP,
  streak INTEGER DEFAULT 0,
  last_task_date DATE,
  fcm_token TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  scan_type scan_type_enum NOT NULL,
  image_url TEXT,
  score DECIMAL(3,1),
  severity severity_enum,
  percentile INTEGER,
  condition_raw JSONB,
  remedies JSONB,
  created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE tracker_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  task_date DATE NOT NULL,
  task_key VARCHAR(100),
  task_title VARCHAR(200),
  task_icon VARCHAR(50),
  category VARCHAR(50),
  duration_minutes INTEGER DEFAULT 10,
  is_premium BOOLEAN DEFAULT false,
  completed BOOLEAN DEFAULT false,
  completed_at TIMESTAMP,
  UNIQUE(user_id, task_date, task_key)
);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  razorpay_order_id VARCHAR(100),
  razorpay_payment_id VARCHAR(100),
  plan plan_enum,
  amount INTEGER,
  status payment_status_enum DEFAULT 'created',
  created_at TIMESTAMP DEFAULT now()
);
```

## Architecture decisions

- Firebase handles OTP delivery (client-side) — server only verifies the Firebase ID token after successful OTP flow. This avoids building an OTP relay and keeps phone verification trustworthy.
- JWT access tokens are short-lived (15min) with long-lived refresh tokens (30d) for a secure mobile-friendly auth pattern.
- Images are compressed to max 1024px JPEG 85% before Gemini API call AND before storage to save bandwidth and cost.
- Remedy/task library (90+ entries) lives in code, not the DB — it's versioned with the code, easy to extend, and eliminates a DB round-trip per tracker load.
- Supabase is accessed via service key (server-side only) — no row-level security bypass needed but RLS can be added per table later.

## Scheduled Jobs

| Time (IST) | Job |
|------------|-----|
| 8:00am daily | Send FCM push reminders to all users with FCM token |
| Midnight | Delete scan images older than 90 days from Supabase Storage |
| 00:05am | Deactivate expired subscriptions |

## User preferences

- Use `req.log` for all request-scoped logging, `logger` for non-request code.
- Never use `console.log` anywhere in server code.
- All routes are wrapped in try/catch with standard `{ error, code }` error responses.

## Gotchas

- Run the SQL migrations in Supabase before connecting the frontend — the API will return 500s if tables don't exist.
- Create the `skinscan-images` bucket in Supabase Storage and set it to **public** so image URLs work without signed tokens.
- Firebase OTP flow: the client calls Firebase Auth (sendSignInLinkToEmail or signInWithPhoneNumber), gets a Firebase ID token after verification, then passes that token to `/api/auth/register` or `/api/auth/login`.
- `FRONTEND_URL` must be set exactly to the Lovable app URL for CORS to allow requests.
