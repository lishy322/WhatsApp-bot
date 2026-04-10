const OpenAI = require('openai');
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const express = require('express');
const admin = require('firebase-admin');
const twilio = require('twilio');
const { MessagingResponse } = require('twilio').twiml;

const app = express();

// חובה בשביל Twilio
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
    const msg = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: 'whatsapp:+972503155522', // שים כאן את המספר שלך
      body: '🔥 הבוט עובד!'
    });

    res.send('✅ הודעה נשלחה!');
  } catch (err) {
    console.error(err);
    res.send('❌ שגיאה: ' + err.message);
  }
});

/* =========================
   🤖 WEBHOOK (הכי חשוב!)
========================= */

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body;

  console.log('📩 הודעה נכנסה:', incomingMsg);

  let reply = '';

  if (incomingMsg === 'היי') {
    reply = 'שלום! 👋 איך אפשר לעזור?';
  } else if (incomingMsg === 'מחיר') {
    reply = 'המחיר הוא 100₪ 💰';
  } else {
    reply = 'לא הבנתי 🤔 תכתוב "היי"';
  }

  // שמירה ב-Firebase (אופציונלי אבל טוב)
  try {
    await db.collection('messages').add({
      text: incomingMsg,
      createdAt: new Date()
    });
  } catch (e) {
    console.log('Firestore error:', e.message);
  }

  const twiml = new MessagingResponse();
  twiml.message(reply);

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

/* =========================
   🌐 SERVER
========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
