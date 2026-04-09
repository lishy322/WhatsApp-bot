const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

// קבלת המפתח מה-ENV
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

// תיקון ה-private key (חשוב מאוד)
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// זיכרון זמני ל-state
let userState = {};

app.post('/webhook', async (req, res) => {
  try {
    const message = (req.body.Body || '').toLowerCase().trim();
    const user = req.body.From;

    console.log('---');
    console.log('USER:', user);
    console.log('MESSAGE:', message);

    if (!userState[user]) {
      userState[user] = { step: 'start' };
    }

    const state = userState[user];
    let reply = '';

    // התחלת שיחה
    if (message.includes('לקבוע')) {
      state.step = 'choosing_time';

      reply = 'יש לי שעות פנויות:\n16:00\n17:00\n18:00\nאיזה שעה נוחה לך?';
    }

    // בחירת שעה ושמירה ב-Firebase
    else if (state.step === 'choosing_time') {
      const cleanTime = message;

      await db.collection('appointments').add({
        user,
        time: cleanTime,
        createdAt: new Date()
      });

      state.step = 'done';

      reply = `סגור! קבעתי לך תור ב-${cleanTime} ✅`;
    }

    // ביטול (בסיסי)
    else if (message.includes('לבטל')) {
      state.step = 'start';
      reply = 'בקשת ביטול התקבלה (נשפר בהמשך)';
    }

    else {
      reply = 'תכתוב "לקבוע תור" או "לבטל תור"';
    }

    res.set('Content-Type', 'text/xml');
    res.send(`
      <Response>
        <Message>${reply}</Message>
      </Response>
    `);

  } catch (err) {
    console.error('ERROR:', err);

    res.status(200).send(`
      <Response>
        <Message>יש תקלה, נסה שוב</Message>
      </Response>
    `);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
