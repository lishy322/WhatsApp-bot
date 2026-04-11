const express = require("express");
const admin = require("firebase-admin");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();
app.use(express.urlencoded({ extended: false }));

// ===== Firebase =====
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ===== Twilio =====
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ===== OpenAI =====
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== שעות זמינות =====
const availableSlots = ["16:00", "17:00", "18:00"];

// ===== בדיקת שרת =====
app.get("/", (req, res) => {
  res.send("Server is alive");
});

// ===== פונקציה: שליחת תזכורת =====
function scheduleReminder(phone, time) {
  const now = new Date();
  const [hour, minute] = time.split(":");

  const appointment = new Date();
  appointment.setHours(hour, minute, 0);

  const diff = appointment - now - 30 * 60 * 1000; // 30 דקות לפני

  if (diff > 0) {
    setTimeout(() => {
      client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: phone,
        body: `⏰ תזכורת: יש לך תור בשעה ${time}`,
      });
    }, diff);
  }
}

// ===== Webhook =====
app.post("/whatsapp", async (req, res) => {
  const incomingMsg = req.body.Body;
  const from = req.body.From;

  try {
    // ===== AI =====
    const ai = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: `
אתה בוט לקביעת תורים.

תחזיר רק JSON:
{
 "intent": "book | greeting | other",
 "time": "HH:MM או null"
}

דוגמאות:
"אני רוצה תור ב16" -> 16:00
"שלום" -> greeting
          `,
        },
        {
          role: "user",
          content: incomingMsg,
        },
      ],
    });

    let data;
    try {
      data = JSON.parse(ai.output_text);
    } catch {
      data = { intent: "other", time: null };
    }

    // ===== ברכה =====
    if (data.intent === "greeting") {
      return res.send(`
        <Response>
          <Message>שלום! 👋 רוצה לקבוע תור?</Message>
        </Response>
      `);
    }

    // ===== אין שעה =====
    if (!data.time) {
      return res.send(`
        <Response>
          <Message>
לא זיהיתי שעה 😅
בחר:
${availableSlots.join(", ")}
          </Message>
        </Response>
      `);
    }

    // ===== בדיקת זמינות =====
    if (!availableSlots.includes(data.time)) {
      return res.send(`
        <Response>
          <Message>
השעה לא זמינה 😕
אפשר:
${availableSlots.join(", ")}
          </Message>
        </Response>
      `);
    }

    // ===== בדיקה אם תפוס =====
    const existing = await db
      .collection("appointments")
      .where("time", "==", data.time)
      .get();

    if (!existing.empty) {
      return res.send(`
        <Response>
          <Message>
התור כבר תפוס 😞
נסה שעה אחרת:
${availableSlots.join(", ")}
          </Message>
        </Response>
      `);
    }

    // ===== שמירה =====
    await db.collection("appointments").add({
      phone: from,
      time: data.time,
      createdAt: new Date(),
    });

    // ===== תזכורת =====
    scheduleReminder(from, data.time);

    // ===== הצלחה =====
    return res.send(`
      <Response>
        <Message>
🎉 נקבע תור לשעה ${data.time}
נשלח תזכורת לפני 🙂
        </Message>
      </Response>
    `);
  } catch (err) {
    console.error(err);

    return res.send(`
      <Response>
        <Message>שגיאה זמנית 😔 נסה שוב</Message>
      </Response>
    `);
  }
});

// ===== הפעלת שרת =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running"));
