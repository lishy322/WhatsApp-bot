const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
app.use(express.urlencoded({ extended: false }));

// ================= בדיקת שרת =================
app.get('/', (req, res) => {
  res.send("Server is alive");
});

// ================= OpenAI =================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================= זמני תורים =================
const availableSlots = ["16:00", "17:00", "18:00"];

// ================= WEBHOOK =================
app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body;
  console.log("📩 הודעה נכנסה:", incomingMsg);

  let reply = "";

  try {
    // ===== AI =====
    const ai = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: `
תחזיר רק JSON בלי טקסט נוסף:
{
 "intent": "book | greeting | other",
 "time": "HH:MM או null"
}
`
        },
        {
          role: "user",
          content: incomingMsg
        }
      ]
    });

    let data;

    try {
      let txt = ai.output[0].content[0].text;

      console.log("🤖 AI RAW:", txt);

      txt = txt.replace(/```json/g, "").replace(/```/g, "").trim();

      data = JSON.parse(txt);

    } catch (e) {
      console.error("❌ JSON PARSE ERROR");

      data = { intent: "other", time: null };
    }

    // ===== לוגיקה =====
    if (data.intent === "book") {
      if (data.time && availableSlots.includes(data.time)) {
        reply = `מעולה 🎉 קבעתי לך תור ל-${data.time}`;
      } else {
        reply = `לא זיהיתי שעה 😅\nבחר אחת:\n${availableSlots.join(", ")}`;
      }

    } else if (data.intent === "greeting") {
      reply = "שלום! 👋 איך אפשר לעזור?";

    } else {
      reply = "אפשר לכתוב: אני רוצה תור ב16:00";
    }

  } catch (err) {
    console.error("🔥 OPENAI ERROR:", err);
    reply = "שגיאה זמנית 😔 נסה שוב";
  }

  // ===== תשובה לוואטסאפ =====
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

// ================= SERVER =================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
