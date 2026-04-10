console.log("🔥 ENV CHECK:");
console.log("TWILIO_ACCOUNT_SID:", !!process.env.TWILIO_ACCOUNT_SID);
console.log("TWILIO_AUTH_TOKEN:", !!process.env.TWILIO_AUTH_TOKEN);
console.log("FIREBASE_KEY:", !!process.env.FIREBASE_KEY);
const express = require('express');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const admin = require('firebase-admin');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// =======================
// 🔐 Twilio
// =======================
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// =======================
// 🔥 Firebase
// =======================
admin.initializeApp({
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

// תיקון חשוב ל־private key
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// =======================
// 📩 Webhook WhatsApp
// =======================
app.post('/whatsapp', async (req, res) => {
  const incomingMsg = req.body.Body;
  const user = req.body.From;

  console.log('USER:', user);
  console.log('MESSAGE:', incomingMsg);

  let reply = '';

  if (incomingMsg.includes('לקבוע')) {
    reply = 'מעולה! שלח שעה (למשל 16:00)';
  } else if (incomingMsg.match(/\d{1,2}:\d{2}/)) {
    await db.collection('appointments').add({
      user: user,
      time: incomingMsg,
      createdAt: new Date(),
      reminded: false
    });

    reply = 'נקבע! תקבל תזכורת ⏰';
  } else {
    reply = 'לא הבנתי, נסה שוב';
  }

  res.set('Content-Type', 'text/xml');
  res.send(`
    <Response>
      <Message>${reply}</Message>
    </Response>
  `);
});

// =======================
// 🧪 TEST לשליחת הודעה
// =======================
app.get('/test', async (req, res) => {
  try {
    console.log('🚀 TEST עובד');

    const msg = await client.messages.create({
      from: 'whatsapp:+14155238886',
      to: 'whatsapp:+972503155522',
      body: '🔥 בדיקה - אם קיבלת זה עובד!'
    });

    console.log('✅ נשלח:', msg.sid);
    res.send('✅ נשלח');
  } catch (err) {
    console.error('❌ שגיאה:', err.message);
    res.send('❌ ' + err.message);
  }
});

// =======================
// ⏰ CRON תזכורות
// =======================
cron.schedule('* * * * *', async () => {
  console.log('⏰ בדיקת תזכורות...');

  const snapshot = await db.collection('appointments').get();
  const now = new Date();

  for (const doc of snapshot.docs) {
    const data = doc.data();

    if (!data.createdAt) continue;

    const createdAt = new Date(data.createdAt);
    const diff = (now - createdAt) / 1000;

    if (diff > 60 && !data.reminded) {
      console.log('📤 שולח תזכורת ל:', data.user);

      try {
        await client.messages.create({
          from: 'whatsapp:+14155238886',
          to: data.user,
          body: `⏰ תזכורת לתור שלך ב-${data.time}`
        });

        await db.collection('appointments').doc(doc.id).update({
          reminded: true
        });

        console.log('✅ תזכורת נשלחה');
      } catch (err) {
        console.error('❌ שגיאה בשליחה:', err.message);
      }
    }
  }
});

// =======================
// 🚀 SERVER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
