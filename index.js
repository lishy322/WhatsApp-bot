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

// ================= שעות =================
const availableSlots = ["16:00", "17:00", "18:00"];

// ================= בדיקת שרת =================
app.get("/", (req, res) => {
  res.send("Server is alive 🚀");
});

// ================= WHATSAPP =================
app.post("/whatsapp", async (req, res) => {
  const incomingMsg = req.body.Body;
  const user = req.body.From;

  console.log("Incoming:", incomingMsg);

  let reply = "";
  const today = new Date().toISOString().split("T")[0];

  // ================= AI =================
  let data;

  try {
    const ai = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: `
תחזיר רק JSON בלי הסברים.

{
 "intent": "book | greeting | other",
 "time": "HH:MM או null"
}
`,
        },
        {
          role: "user",
          content: incomingMsg,
        },
      ],
    });

    let txt = ai.output[0].content[0].text;
    txt = txt.replace(/```json/g, "").replace(/```/g, "").trim();

    data = JSON.parse(txt);

    // תיקון שעה כמו "18"
    if (data.time && data.time.length === 2) {
      data.time = data.time + ":00";
    }

  } catch (err) {
    console.log("AI ERROR:", err);

    // fallback שלא שובר
    const match = incomingMsg.match(/\d{1,2}/);
    if (match) {
      data = {
        intent: "book",
        time: match[0].padStart(2, "0") + ":00",
      };
    } else {
      data = { intent: "other", time: null };
    }
  }

  console.log("AI DATA:", data);

  // ================= לוגיקה =================
  if (data.time) {
  data.intent = "book";
  }
  if (data.intent === "greeting") {
    reply = "שלום! 👋 רוצה לקבוע תור?";
  }

  else if (data.intent === "book") {

    if (!data.time) {
      reply = `איזה שעה נוחה לך?\n${availableSlots.join(", ")}`;
    }

    else if (!availableSlots.includes(data.time)) {
      reply = `השעה לא זמינה 😅\nבחר אחת:\n${availableSlots.join(", ")}`;
    }

    else {
      try {
        const snapshot = await db
          .collection("appointments")
          .where("time", "==", data.time)
          .where("date", "==", today)
          .get();

        if (!snapshot.empty) {
          reply = `התור תפוס 😞\nבחר שעה אחרת:\n${availableSlots.join(", ")}`;
        } else {
          await db.collection("appointments").add({
            user,
            time: data.time,
            date: today,
            createdAt: new Date(),
          });

          reply = `🎉 התור נקבע ל-${data.time}`;
        }

      } catch (err) {
        console.log("FIREBASE ERROR:", err);
        reply = "שגיאה זמנית 😔 נסה שוב";
      }
    }
  }

  else {
    reply = "אפשר לכתוב: אני רוצה תור ב16:00 🙂";
  }

  // ================= תשובה =================
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

// ================= PORT =================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running on port", PORT));
