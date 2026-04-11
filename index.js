const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
app.use(express.urlencoded({ extended: false }));

// בדיקת שרת
app.get('/', (req, res) => {
  res.send("Server is alive");
});

// OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// זמני תורים
const availableSlots = ["16:00", "17:00", "18:00"];

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body;

  console.log("📩 הודעה:", incomingMsg);

  let reply = "";

  try {
    const ai = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
תחזיר רק JSON:
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
      let txt = ai.choices[0].message.content;
      txt = txt.replace(/```json/g, "").replace(/```/g, "").trim();
      data = JSON.parse(txt);
    } catch {
      data = { intent: "other", time: null };
    }

    if (data.intent === "book") {
      if (availableSlots.includes(data.time)) {
        reply = `מעולה 🎉 קבעתי לך תור ל-${data.time}`;
      } else {
        reply = `בחר שעה:\n${availableSlots.join(", ")}`;
      }
    } else if (data.intent === "greeting") {
      reply = "שלום! איך אפשר לעזור?";
    } else {
      reply = "אפשר לכתוב: אני רוצה תור ב16:00";
    }

  } catch (err) {
    console.error(err);
    reply = "שגיאה זמנית 😔 נסה שוב";
  }

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml.toString());
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("🚀 Server running");
});
