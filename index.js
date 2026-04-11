const express = require('express');
const admin = require('firebase-admin');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
app.use(express.urlencoded({ extended: false }));

// ================= FIREBASE =================
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ================= TWILIO =================
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ================= OPENAI =================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================= זמני תורים =================
const availableSlots = ["16:00", "17:00", "18:00"];

// ================= WEBHOOK =================
app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body;
  const user = req.body.From;

  console.log("📩 הודעה נכנסה:", incomingMsg);

  try {
    // ================= AI =================
    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
אתה בוט לקביעת תורים.
תחזיר רק JSON בלי טקסט נוסף.

פורמט:
{
  "intent": "book | greeting | other",
  "time": "HH:MM או null",
  "reply": "טקסט למשתמש"
}

דוגמאות:
"שלום אני רוצה להגיע מחר ב16" ->
{ "intent": "book", "time": "16:00", "reply": "מעולה, בודק זמינות..." }

"היי" ->
{ "intent": "greeting", "time": null, "reply": "שלום! איך אפשר לעזור?" }
`
        },
        {
          role: "user",
          content: incomingMsg
        }
      ]
    });

    // ================= תיקון קריסה =================
    let data;

    try {
      let aiText = ai.choices[0].message.content;

      console.log("🤖 AI RAW:", aiText);

      aiText = aiText.replace(/```json/g, "").replace(/```/g, "").trim();

      data = JSON.parse(aiText);

    } catch (e) {
      console.error("❌ שגיאת פירס AI");

      data = {
        intent: "other",
        time: null,
        reply: "לא הבנתי 😅 תוכל לבחור שעה מהרשימה?"
      };
    }

    let reply = "";

    // ================= לוגיקה =================
    if (data.intent === "book") {
      if (data.time && availableSlots.includes(data.time)) {
        
        await db.collection("appointments").add({
          user,
          time: data.time,
          createdAt: new Date()
        });

        reply = `מעולה 🎉 קבעתי לך תור ל-${data.time}`;

      } else {
        reply = `לא זיהיתי שעה 😅\nבחר אחת מהאפשרויות:\n${availableSlots.join(", ")}`;
      }

    } else if (data.intent === "greeting") {
      reply = "שלום! 👋 איך אפשר לעזור?\nאפשר לכתוב: לקבוע תור";

    } else {
      reply = "אפשר לקבוע תור 🙂 כתוב למשל: אני רוצה להגיע ב16:00";
    }

    // ================= שליחה לוואטסאפ =================
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());

  } catch (error) {
    console.error("🔥 שגיאה כללית:", error);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("אירעה שגיאה 😔 נסה שוב");

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  }
});

// ================= SERVER =================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
