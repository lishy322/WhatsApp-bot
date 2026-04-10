const express = require('express');
const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();;
const twilio = require('twilio');
const { MessagingResponse } = require('twilio').twiml;
const OpenAI = require('openai');

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

/* ================= FIREBASE ================= */

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

/* ================= OPENAI ================= */

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ================= TWILIO ================= */

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/* ================= HELPERS ================= */

const availableSlots = ["10:00", "12:00", "14:00", "16:00"];

function isBookingRequest(text) {
  const t = text.trim();
  return t.includes("תור") || t.includes("לקבוע");
}

function isTimeSelected(text) {
  return availableSlots.includes(text);
}

/* ================= WEBHOOK ================= */

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body;
  const userId = req.body.From;

  console.log('📩:', incomingMsg);

  let reply = '';

  try {
    /* ================= שלב 1: בקשת תור ================= */

    if (true) {
      reply = `יש לנו שעות פנויות:\n${availableSlots.join(", ")}\nאיזו שעה נוחה לך?`;
    }

    /* ================= שלב 2: בחירת שעה ================= */

    else if (isTimeSelected(incomingMsg)) {

      await db.collection('appointments').add({
        user: userId,
        time: incomingMsg,
        createdAt: new Date()
      });

      reply = `✅ התור נקבע ל-${incomingMsg}\nנשלח לך תזכורת 🙌`;
    }

    /* ================= שלב 3: AI ================= */

    else {

      // היסטוריה
      let messages = [
        {
          role: "system",
          content: "אתה נציג שירות אדיב, קצר, ועוזר לקבוע תורים."
        }
      ];

      const history = await db
        .collection('conversations')
        .doc(userId)
        .collection('messages')
        .orderBy('createdAt', 'desc')
        .limit(5)
        .get();

      history.forEach(doc => {
        messages.unshift(doc.data());
      });

      messages.push({
        role: "user",
        content: incomingMsg
      });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messages,
      });

      reply = completion.choices[0].message.content;

      // שמירת שיחה
      await db.collection('conversations')
        .doc(userId)
        .collection('messages')
        .add({
          role: "user",
          content: incomingMsg,
          createdAt: new Date()
        });

      await db.collection('conversations')
        .doc(userId)
        .collection('messages')
        .add({
          role: "assistant",
          content: reply,
          createdAt: new Date()
        });
    }

  } catch (err) {
    console.error(err);
    reply = "יש תקלה קטנה 😅 נסה שוב";
  }

  const twiml = new MessagingResponse();
  twiml.message(reply);

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

/* ================= SERVER ================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});
