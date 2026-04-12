require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const axios = require("axios");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ================= Firebase =================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY))
  });
}
const db = admin.firestore();

// ================= Config =================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const availableSlots = [
  "16:00","16:15","16:30","16:45",
  "17:00","17:15","17:30","17:45",
  "18:00","18:15","18:30"
];

// ================= Twilio =================
const sendWhatsApp = async (to, body) => {
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    new URLSearchParams({
      From: "whatsapp:" + process.env.TWILIO_WHATSAPP_NUMBER,
      To: "whatsapp:" + to,
      Body: body
    }),
    {
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN
      }
    }
  );
};

// ================= Helpers =================

// זיהוי שעה גם אם כתבו "17"
const extractTime = (msg) => {
  const match = msg.match(/\d{1,2}(:\d{2})?/);
  if (!match) return null;
  let t = match[0];
  if (!t.includes(":")) t += ":00";
  return t.padStart(5, "0");
};

// זיהוי יום
const extractDate = (msg) => {
  const today = new Date();
  msg = msg.toLowerCase();

  if (msg.includes("מחר")) {
    today.setDate(today.getDate() + 1);
    return today.toISOString().split("T")[0];
  }

  const daysMap = {
    "ראשון": 0,
    "שני": 1,
    "שלישי": 2,
    "רביעי": 3,
    "חמישי": 4,
    "שישי": 5,
    "שבת": 6
  };

  for (let day in daysMap) {
    if (msg.includes(day)) {
      const target = daysMap[day];
      const diff = (target - today.getDay() + 7) % 7 || 7;
      today.setDate(today.getDate() + diff);
      return today.toISOString().split("T")[0];
    }
  }

  return today.toISOString().split("T")[0];
};

// תאריך יפה
const formatDate = (dateStr) => {
  const d = new Date(dateStr);
  return `${d.getDate().toString().padStart(2,"0")}/${(d.getMonth()+1)
    .toString().padStart(2,"0")}`;
};

// ================= AI =================
async function detectIntent(message) {
  try {
    const res = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: "gpt-5.3-mini",
        input: `הודעה: "${message}"
תחזיר JSON בלבד:
{
 "intent": "book | cancel | greeting | other"
}`
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    let txt = res.data.output[0].content[0].text;
    txt = txt.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(txt);
  } catch {
    return { intent: "other" };
  }
}

// ================= State (זיכרון שיחה) =================
const userState = {};

// ================= Webhook =================
app.post("/whatsapp", async (req, res) => {
  try {
    const incomingMsg = req.body.Body;
    const user = req.body.From.replace("whatsapp:", "");

    const ai = await detectIntent(incomingMsg);
    let intent = ai.intent;

    let state = userState[user] || {};

    const time = extractTime(incomingMsg);
    const date = extractDate(incomingMsg);

    let reply = "";

    // ===== Greeting =====
    if (intent === "greeting") {
      reply = "היי 👋 רוצה לקבוע תור?";
      userState[user] = { step: "ask_booking" };
    }

    // ===== התחלה =====
    else if (incomingMsg.includes("כן") || intent === "book") {
      userState[user] = { step: "ask_time", date };
      reply = `מעולה 👍 איזה שעה נוחה לך?\n${availableSlots.slice(0,5).join(", ")}`;
    }

    // ===== קיבל שעה =====
    else if (state.step === "ask_time" && time) {

      if (!availableSlots.includes(time)) {
        reply = `השעה ${time} לא זמינה 😅\nאפשר:\n${availableSlots.slice(0,6).join(", ")}`;
      } else {

        const snapshot = await db
          .collection("appointments")
          .where("date", "==", state.date || date)
          .where("time", "==", time)
          .get();

        if (!snapshot.empty) {
          reply = `התור תפוס 😞\nבחר:\n${availableSlots.slice(0,6).join(", ")}`;
        } else {

          await db.collection("appointments").add({
            user,
            date: state.date || date,
            time,
            createdAt: new Date(),
            reminder1: false,
            reminder2: false
          });

          reply = `🎉 נקבע תור ל-${formatDate(state.date || date)} בשעה ${time}`;
          delete userState[user];
        }
      }
    }

    // ===== ביטול =====
    else if (intent === "cancel") {
      const snapshot = await db
        .collection("appointments")
        .where("user", "==", user)
        .get();

      if (snapshot.empty) {
        reply = "אין לך תור 🤔";
      } else {
        snapshot.forEach(async (doc) => await doc.ref.delete());
        reply = "התור בוטל 👍";
      }
    }

    // ===== fallback =====
    else {
      reply = "לא הבנתי 😅 רוצה לקבוע תור?";
    }

    await sendWhatsApp(user, reply);
    res.send("OK");

  } catch (err) {
    console.error(err);
    res.send("error");
  }
});

// ================= Reminders =================
app.get("/run-reminders", async (req, res) => {
  const now = new Date();
  const snapshot = await db.collection("appointments").get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const appt = new Date(`${data.date}T${data.time}`);
    const diffMin = (appt - now) / 60000;

    if (diffMin < 1440 && !data.reminder1) {
      await sendWhatsApp(data.user, `📅 תזכורת: מחר יש לך תור ב-${data.time}`);
      await doc.ref.update({ reminder1: true });
    }

    if (diffMin < 60 && !data.reminder2) {
      await sendWhatsApp(data.user, `⏰ התור בעוד שעה`);
      await doc.ref.update({ reminder2: true });
    }
  }

  res.send("OK");
});

// ================= Health =================
app.get("/", (req, res) => {
  res.send("Server is alive ✅");
});

// ================= Server =================
app.listen(8080, () => {
  console.log("🚀 Server running on port 8080");
});
