const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const cron = require('node-cron');
const twilio = require('twilio');

// 🔐 Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// 📲 Twilio
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// =======================
// 📩 WEBHOOK
// =======================
app.post('/webhook', async (req, res) => {
  try {
    console.log('קיבלתי הודעה!');

    const message = (req.body.Body || '').trim();
    const user = req.body.From;

    console.log('USER:', user);
    console.log('MESSAGE:', message);

    let reply = '';

    if (message.includes('לקבוע')) {
      reply = 'יש לי שעות פנויות: 16:00, 17:00, 18:00\nאיזה שעה נוחה לך?';
    }

    else if (message.includes(':')) {
      await db.collection('appointments').add({
        user: user,
        time: message,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        reminded: false
      });

      reply = `סגור! קבעתי לך תור ב-${message} ✅`;
    }

    else {
      reply = 'לא הבנתי 🤔 כתוב "לקבוע תור"';
    }

    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);

  } catch (err) {
    console.error('ERROR:', err);

    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Message>שגיאה, נסה שוב</Message>
      </Response>
    `);
  }
});

// =======================
// 🔔 CRON - תזכורות
// =======================
cron.schedule('* * * * *', async () => {
  try {
    console.log('cron עובד - בדיקה כל דקה');

    const snapshot = await db.collection('appointments').get();
    const now = new Date();

    for (const doc of snapshot.docs) {
      const data = doc.data();

      if (!data.createdAt) continue;

      const createdAt = data.createdAt.toDate();
      const diffSeconds = (now - createdAt) / 1000;

      if (diffSeconds > 60 && !data.reminded) {
        console.log('צריך לשלוח תזכורת ל:', data.user);
        console.log('נכנס לשליחה...');

        try {
          const msg = await client.messages.create({
            from: 'whatsapp:+14155238886',
            to: data.user,
            body: 'תזכורת: יש לך תור שקבעת ⏰'
          });

          console.log('נשלח! SID:', msg.sid);

          await db.collection('appointments').doc(doc.id).update({
            reminded: true
          });

        } catch (err) {
          console.error('שגיאה בשליחה:', err.message);
        }
      }
    }

  } catch (err) {
    console.error('CRON ERROR:', err);
  }
});

// =======================
// 🚀 SERVER
// =======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
