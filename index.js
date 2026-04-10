require('dotenv').config();

const express = require('express');
const admin = require('firebase-admin');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* =========================
   🔥 FIREBASE CONFIG
========================= */

const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* =========================
   📲 TWILIO CONFIG
========================= */

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/* =========================
   🚀 TEST ROUTE
========================= */

app.get('/test', async (req, res) => {
  try {
    console.log('🚀 שליחת הודעת בדיקה');

    const msg = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: 'whatsapp:+972503155522', // תשנה למספר שלך
      body: '🔥 הבוט עובד תקין!',
    });

    res.send('✅ הודעה נשלחה: ' + msg.sid);
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ שגיאה: ' + err.message);
  }
});

/* =========================
   🌐 SERVER
========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
