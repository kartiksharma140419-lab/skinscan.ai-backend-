import admin from "firebase-admin";

let app: admin.app.App | null = null;

function getFirebaseApp(): admin.app.App {
  if (app) return app;

  const projectId = process.env["FIREBASE_PROJECT_ID"];
  const clientEmail = process.env["FIREBASE_CLIENT_EMAIL"];
  const privateKeyRaw = process.env["FIREBASE_PRIVATE_KEY"];
  
  if (projectId && clientEmail && privateKeyRaw) {
    let privateKey = privateKeyRaw.trim();
    privateKey = privateKey.replace(/^["']|["']$/g, ""); // Remove surrounding quotes
    privateKey = privateKey.replace(/\\n/g, "\n"); // Replace escaped newlines
    privateKey = privateKey.replace(/\r/g, ""); // Remove carriage returns

    // Extract the body and rebuild to ensure perfect PEM formatting
    const match = privateKey.match(/-----BEGIN PRIVATE KEY-----\s*(.*?)\s*-----END PRIVATE KEY-----/s);
    if (match) {
      const body = match[1].replace(/\s+/g, "");
      const formattedBody = body.match(/.{1,64}/g)?.join("\n") || body;
      privateKey = `-----BEGIN PRIVATE KEY-----\n${formattedBody}\n-----END PRIVATE KEY-----\n`;
    }

    app = admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
    return app;
  }

  const serviceAccountJson = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  if (!serviceAccountJson) {
    throw new Error("Firebase Service Account JSON or individual FIREBASE_ keys are required");
  }

  const serviceAccount = JSON.parse(serviceAccountJson);

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return app;
}

export function getMessaging(): admin.messaging.Messaging {
  return getFirebaseApp().messaging();
}

export function getFirebaseAuth(): admin.auth.Auth {
  return getFirebaseApp().auth();
}
