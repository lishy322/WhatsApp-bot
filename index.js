const express = require("express");
const admin = require("firebase-admin");
const twilio = require("twilio");
const OpenAI = require("openai");

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

// ================= HELPERS =================
const getToday = () => {
  return new Date().toISOString().split("T")[0];
};

async function getAvailableSlots() {
  const today = getToday();

  const snapshot = await db
    .collection("appointments")
    .where("date", "==", today)
    .get();

  const booked = snapshot.docs.map((doc) => doc.data().time);

  const allSlots = ["16:00", "17:00", "18:00"];

  return allSlots.filter((slot) => !booked.includes(slot));
}

async function bookAppointment(phone, time) {
  const today = getToday();

  await db.collection("appointments").add({
    phone,
    date: today,
    time,
    createdAt: new Date(),
  });
}

// ================= MEMORY =================
const sessions = {};

// ================= WEBHOOK =================
app.post("/whatsapp", async (req, res) => {
  try {
    const incomingMsg = (req.body.Body || "").trim();
    const from = req.body.From;

    let reply = "";

    // יצירת סשן אם אין
    if (!sessions[from]) {
      sessions[from] = { step: "start" };
    }

    const user = sessions[from];

    // ================= שלב 1 =================
   if (user.step === "start") {
  user.step = "ai";
}

    // ================= שלב AI =================
    else if (user.step === "ai") {
      // אם רוצה לקבוע תור → מעבר לתהליך
      if (
        incomingMsg.includes("תור") ||
        incomingMsg.includes("לקבוע")
      ) {
        const slots = await getAvailableSlots();

        if (slots.length === 0) {
          reply = "מצטערים 😔 אין תורים פנויים היום";
          return res.send(`<Response><Message>${reply}</Message></Response>`);
        }

        reply =
          "מעולה 🙌\nיש שעות פנויות:\n" +
          slots.join(", ") +
          "\n\nאיזה שעה מתאימה לך?";

        user.step = "booking";
        return res.send(`<Response><Message>${reply}</Message></Response>`);
      }

      // AI רגיל
      const ai = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [
    {
      role: "system",
      content: `
תחזיר תשובה רק בפורמט JSON:

{
  "intent": "book / other",
  "time": "16:00 או null",
  "reply": "תשובה ללקוח"
}

חוקים:
- אם הלקוח רוצה לקבוע תור → intent = book
- אם הוא כתב שעה → תכניס אותה ל-time
- אחרת → intent = other
- תמיד תענה בעברית
`,
    },
    {
      role: "user",
      content: incomingMsg,
    },
  ],
});

const data = JSON.parse(ai.choices[0].message.content);
      if (data.intent === "book") {
  const slots = await getAvailableSlots();

  if (data.time && slots.includes(data.time)) {
    await bookAppointment(from, data.time);
    reply = `מעולה! 🎉 התור נקבע ל-${data.time}`;
  } else {
    reply = "יש שעות פנויות: " + slots.join(", ");
  }
} else {
  reply = data.reply;
}

      reply = ai.choices[0].message.content;
    }

    // ================= שלב קביעת תור =================
    else if (user.step === "booking") {
      const slots = await getAvailableSlots();

      const selected = slots.find((slot) =>
        incomingMsg.includes(slot)
      );

      if (selected) {
        await bookAppointment(from, selected);

        reply = `מעולה! 🎉\nהתור נקבע ל-${selected}.\nמחכים לך! 😊`;

        user.step = "done";
      } else {
        reply =
          "לא זיהיתי שעה 😅\nבחר אחת מהאפשרויות:\n" +
          slots.join(", ");
      }
    }

    // ================= סיום =================
    else {
  user.step = "ai";
  reply = "בכיף 🙂 איך אפשר לעזור?";
}

    res.send(`<Response><Message>${reply}</Message></Response>`);
  } catch (error) {
    console.error("ERROR:", error);
    res.send(`<Response><Message>אירעה שגיאה 😔 נסה שוב</Message></Response>`);
  }
});

// ================= SERVER =================
app.listen(8080, () => {
  console.log("🚀 Server running on port 8080");
});
