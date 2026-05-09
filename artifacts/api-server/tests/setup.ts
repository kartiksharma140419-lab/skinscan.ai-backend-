import { vi } from "vitest";

const { mockDb } = vi.hoisted(() => {
  return {
    mockDb: {
      otp_codes: [] as any[],
      users: [] as any[],
      scan_history: [] as any[],
      scans: [] as any[],
    }
  };
});

(globalThis as any).mockDb = mockDb;

// Mock Supabase
vi.mock("../src/lib/supabase.js", () => {
  const createQueryBuilder = (table: string) => {
    let queryArgs: any = {};
    let action = 'select';
    const execute = () => {
      let results: any = [];
      let error = null;
      
      if (!mockDb[table]) mockDb[table] = [];

      if (action === 'insert') {
        mockDb[table].push(...queryArgs.data);
        results = queryArgs.data;
      } else if (action === 'update') {
        let updated: any[] = [];
        mockDb[table] = mockDb[table].map((row: any) => {
          let match = true;
          for (const key of Object.keys(queryArgs.eq || {})) {
            if (row[key] !== queryArgs.eq[key]) match = false;
          }
          if (match) {
            const newRow = { ...row, ...queryArgs.data };
            updated.push(newRow);
            return newRow;
          }
          return row;
        });
        results = updated;
      } else if (action === 'select') {
        results = mockDb[table].filter((row: any) => {
          let match = true;
          for (const key of Object.keys(queryArgs.eq || {})) {
            if (row[key] !== queryArgs.eq[key]) match = false;
          }
          if (queryArgs.gt) {
            for (const key of Object.keys(queryArgs.gt)) {
              if (row[key] <= queryArgs.gt[key]) match = false;
            }
          }
          if (queryArgs.gte) {
            for (const key of Object.keys(queryArgs.gte)) {
              if (row[key] < queryArgs.gte[key]) match = false;
            }
          }
          if (queryArgs.lte) {
            for (const key of Object.keys(queryArgs.lte)) {
              if (row[key] > queryArgs.lte[key]) match = false;
            }
          }
          if (queryArgs.in) {
            for (const key of Object.keys(queryArgs.in)) {
              if (!queryArgs.in[key].includes(row[key])) match = false;
            }
          }
          return match;
        });
      } else if (action === 'delete') {
        mockDb[table] = mockDb[table].filter((row: any) => {
          let match = true;
          for (const key of Object.keys(queryArgs.eq || {})) {
            if (row[key] !== queryArgs.eq[key]) match = false;
          }
          return !match;
        });
        results = null;
      }

      if (queryArgs.single && Array.isArray(results)) {
        if (results.length === 0 && action === 'select') {
          return { data: null, error: new Error("Not found") };
        }
        return { data: results[0] || null, error: null };
      }
      return { data: results, error };
    };

    const builder: any = {
      insert: (data: any) => { action = 'insert'; queryArgs.data = Array.isArray(data) ? data : [data]; return builder; },
      update: (data: any) => { action = 'update'; queryArgs.data = data; return builder; },
      delete: () => { action = 'delete'; return builder; },
      select: (cols: any) => { return builder; },
      eq: (col: string, val: any) => { queryArgs.eq = { ...queryArgs.eq, [col]: val }; return builder; },
      gt: (col: string, val: any) => { queryArgs.gt = { ...queryArgs.gt, [col]: val }; return builder; },
      lt: (col: string, val: any) => { queryArgs.lt = { ...queryArgs.lt, [col]: val }; return builder; },
      gte: (col: string, val: any) => { queryArgs.gte = { ...queryArgs.gte, [col]: val }; return builder; },
      lte: (col: string, val: any) => { queryArgs.lte = { ...queryArgs.lte, [col]: val }; return builder; },
      in: (col: string, vals: any[]) => { queryArgs.in = { ...queryArgs.in, [col]: vals }; return builder; },
      limit: () => builder,
      single: () => { queryArgs.single = true; return execute(); },
      then: (resolve: any) => resolve(execute())
    };
    return builder;
  };

  return {
    supabase: {
      from: vi.fn((table: string) => createQueryBuilder(table)),
    },
  };
});

// Mock Firebase Admin
vi.mock("firebase-admin", () => ({
  default: {
    initializeApp: vi.fn(() => ({
      auth: () => ({
        verifyIdToken: vi.fn().mockResolvedValue({
          uid: "mock-uid",
          email: "mock@google.com",
          name: "Mock Google User",
        }),
      }),
      messaging: () => ({}),
    })),
    credential: {
      cert: vi.fn(),
    },
  },
}));

// Mock Nodemailer
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn().mockResolvedValue(true),
    })),
  },
}));
