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
const availableSlots = [
  "16:00","16:15","16:30","16:45",
  "17:00","17:15","17:30","17:45",
  "18:00","18:15"
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

  const days = {
    "ראשון":0,"שני":1,"שלישי":2,"רביעי":3,
    "חמישי":4,"שישי":5,"שבת":6
  };

  for (let d in days) {
    if (msg.includes(d)) {
      let diff = days[d] - today.getDay();
      if (diff <= 0) diff += 7;
      today.setDate(today.getDate() + diff);
    }
  }

  return today.toISOString().split("T")[0];
};

const detectPreference = (msg) => {
  msg = msg.toLowerCase();

  if (msg.includes("בוקר")) return "morning";
  if (msg.includes("ערב") || msg.includes("אחרי")) return "evening";

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

// ================= State =================
const userState = {};

// ================= Webhook =================
app.post("/whatsapp", async (req, res) => {
  try {
    const msg = req.body.Body.toLowerCase();
    const user = req.body.From.replace("whatsapp:", "");

    if (!userState[user]) userState[user] = {};

    let state = userState[user];

    // 🔥 תמיד לעדכן מידע אם מופיע
    const newTime = extractTime(msg);
    const newDate = extractDate(msg);
    const newPref = detectPreference(msg);

    if (newDate) state.date = newDate;
    if (newPref) state.pref = newPref;
    if (newTime) state.time = newTime;

    let reply = "";

    // התחלה
    if (msg.includes("היי") || msg.includes("שלום")) {
      reply = "היי 👋 רוצה לקבוע תור?";
      userState[user] = {};
    }

    // התחלת תהליך
    else if (msg.includes("תור") || msg.includes("כן")) {
      state.step = "time";

      const slots = filterSlots(availableSlots, state.pref);

      reply = `מעולה 👍 איזה שעה נוחה לך?\n${slots.slice(0,5).join(", ")}`;
    }

    // יש זמן → קובעים
    else if (state.step === "time" && state.time) {

      const slots = filterSlots(availableSlots, state.pref);

      if (!slots.includes(state.time)) {

        reply = `השעה ${state.time} לא פנויה 😅\n👉 ${slots.slice(0,3).join(", ")}`;
      }

      else {

        const snap = await db
          .collection("appointments")
          .where("date", "==", state.date)
          .where("time", "==", state.time)
          .get();

        if (!snap.empty) {
          reply = "התור תפוס 😞 נסה שעה אחרת";
        } else {

          await db.collection("appointments").add({
            user,
            date: state.date,
            time: state.time
          });

          reply = `🎉 נקבע תור ל-${state.date} בשעה ${state.time}`;
          delete userState[user];
        }
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
