import admin from "firebase-admin";

let app: admin.app.App | null = null;

function getFirebaseApp(): admin.app.App {
  if (app) return app;

  const serviceAccountJson = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  if (!serviceAccountJson) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is required");
  }

  const serviceAccount = JSON.parse(serviceAccountJson);

  app = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return app;
}

export function getAuth(): admin.auth.Auth {
  return getFirebaseApp().auth();
}

export function getMessaging(): admin.messaging.Messaging {
  return getFirebaseApp().messaging();
}

export async function verifyFirebaseIdToken(idToken: string): Promise<string> {
  const auth = getAuth();
  const decoded = await auth.verifyIdToken(idToken);
  return decoded.phone_number ?? decoded.uid;
}
