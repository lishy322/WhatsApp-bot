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

const extractTime = (msg) => {
  const match = msg.match(/\d{1,2}(:\d{2})?/);
  if (!match) return null;
  let t = match[0];
  if (!t.includes(":")) t += ":00";
  return t.padStart(5, "0");
};

const extractDate = (msg) => {
  const today = new Date();
  if (msg.includes("מחר")) {
    today.setDate(today.getDate() + 1);
  }
  return today.toISOString().split("T")[0];
};

const detectPreference = (msg) => {
  msg = msg.toLowerCase();
  if (msg.includes("ערב") || msg.includes("אחרי")) return "evening";
  if (msg.includes("בוקר") || msg.includes("מוקדם")) return "morning";
  return null;
};

const filterSlots = (slots, pref) => {
  if (!pref) return slots;
  return slots.filter(t => {
    const h = parseInt(t.split(":")[0]);
    if (pref === "morning") return h < 14;
    if (pref === "evening") return h >= 16;
    return true;
  });
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
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
      }
    );

    let txt = res.data.output[0].content[0].text;
    txt = txt.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(txt);

  } catch {
    return { intent: "other" };
  }
}

// ================= State =================
const userState = {};

// ================= Webhook =================
app.post("/whatsapp", async (req, res) => {
  try {
    const msg = req.body.Body.toLowerCase();
    const user = req.body.From.replace("whatsapp:", "");

    let state = userState[user] || {};

    let ai = await detectIntent(msg);
    let intent = ai.intent;

    // 🔥 FIX קריטי — fallback חכם
    if (msg.includes("תור") || msg.includes("לקבוע")) {
      intent = "book";
    }
    if (msg.includes("שלום") || msg.includes("היי")) {
      intent = "greeting";
    }

    const time = extractTime(msg);
    const date = extractDate(msg);
    const pref = detectPreference(msg);

    let reply = "";

    // ===== Greeting =====
    if (intent === "greeting") {
      reply = "היי 👋 רוצה לקבוע תור?";
      userState[user] = {};
    }

    // ===== התחלת תהליך =====
    else if (intent === "book" && !state.step) {
      userState[user] = { step: "time", date, pref };
      const slots = filterSlots(availableSlots, pref);

      reply = `מעולה 👍 איזה שעה נוחה לך?\n${slots.slice(0,5).join(", ")}`;
    }

    // ===== קבלת שעה =====
    else if (state.step === "time" && time) {

      let slots = filterSlots(availableSlots, state.pref);

      if (!slots.includes(time)) {

        const h = parseInt(time);
        const suggestions = slots.filter(t => {
          const sh = parseInt(t);
          return Math.abs(sh - h) <= 1;
        });

        reply = `השעה ${time} לא פנויה 😅\n👉 ${suggestions.slice(0,3).join(", ")}`;
      }

      else {

        const snap = await db
          .collection("appointments")
          .where("date", "==", state.date)
          .where("time", "==", time)
          .get();

        if (!snap.empty) {
          reply = "התור תפוס 😞 נסה שעה אחרת";
        } else {

          await db.collection("appointments").add({
            user,
            date: state.date,
            time,
            reminder1: false,
            reminder2: false
          });

          reply = `🎉 נקבע תור ל-${state.date} בשעה ${time}`;
          delete userState[user];
        }
      }
    }

    // ===== ביטול =====
    else if (intent === "cancel") {
      const snap = await db
        .collection("appointments")
        .where("user", "==", user)
        .get();

      if (snap.empty) {
        reply = "אין לך תור 🤔";
      } else {
        snap.forEach(async d => await d.ref.delete());
        reply = "התור בוטל 👍";
      }
    }

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

// ================= Server =================
app.listen(8080, () => {
  console.log("🚀 Server running");
});
