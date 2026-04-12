require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const axios = require("axios");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static("public"));

// ================= Firebase =================
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY))
  });
}
const db = admin.firestore();

// ================= שירותים =================
const services = {
  male: 15,
  female: 40,
  child: 20
};

// ================= לוז בסיס =================
const baseSlots = [
  "08:00","08:15","08:30","08:45",
  "09:00","09:15","09:30","09:45",
  "10:00","10:15","10:30","10:45",
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

// המרת שעה לדקות
const toMinutes = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

// המרת דקות לשעה
const toTime = (min) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h.toString().padStart(2,"0")}:${m.toString().padStart(2,"0")}`;
};

// זיהוי שעה
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

  if (msg.includes("מחר")) {
    today.setDate(today.getDate() + 1);
  }

  return today.toISOString().split("T")[0];
};

// סוג לקוח
const detectType = (msg) => {
  if (msg.includes("אישה")) return "female";
  if (msg.includes("ילד")) return "child";
  if (msg.includes("גבר")) return "male";
  return null;
};

// ================= לוגיקה אמיתית =================

// בדיקה אם זמן פנוי (כולל משך)
const isSlotAvailable = (startTime, duration, booked) => {
  const start = toMinutes(startTime);
  const end = start + duration;

  for (let b of booked) {
    const bStart = toMinutes(b.time);
    const bEnd = bStart + b.duration;

    if (start < bEnd && end > bStart) {
      return false;
    }
  }
  return true;
};

// מציאת זמינות אמיתית
const getAvailableSlots = async (date, duration) => {
  const snapshot = await db
    .collection("appointments")
    .where("date", "==", date)
    .get();

  const booked = snapshot.docs.map(d => d.data());

  const validSlots = [];

  for (let slot of baseSlots) {
    if (isSlotAvailable(slot, duration, booked)) {
      validSlots.push(slot);
    }
  }

  return validSlots;
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

    const time = extractTime(msg);
    const date = extractDate(msg);
    const type = detectType(msg);

    if (date) state.date = date;
    if (time) state.time = time;
    if (type) state.type = type;

    let reply = "";

    // התחלה
    if (msg.includes("היי") || msg.includes("שלום")) {
      reply = "היי 👋 רוצה לקבוע תור?";
      userState[user] = {};
    }

    // התחלה תהליך
    else if (msg.includes("תור") || msg.includes("כן")) {
      state.step = "type";
      reply = "למי התור?\n👉 גבר / אישה / ילד";
    }

    // סוג
    else if (state.step === "type" && state.type) {
      state.step = "time";

      const duration = services[state.type];
      const slots = await getAvailableSlots(state.date, duration);

      if (slots.length === 0) {
        reply = "אין תורים פנויים 😔 רוצה יום אחר?";
      } else {
        reply = `השעות הפנויות:\n👉 ${slots.slice(0,5).join(", ")}`;
      }
    }

    // קביעת תור
    else if (state.step === "time" && state.time) {

      const duration = services[state.type];
      const slots = await getAvailableSlots(state.date, duration);

      if (!slots.includes(state.time)) {
        reply = `השעה לא פנויה 😅\n👉 ${slots.slice(0,3).join(", ")}`;
      } else {

        await db.collection("appointments").add({
          user,
          date: state.date,
          time: state.time,
          type: state.type,
          duration
        });

        reply = `🎉 נקבע תור ל-${state.date} בשעה ${state.time}`;
        delete userState[user];
      }
    }

    // בקשת זמינות
    else if (msg.includes("פנוי")) {

      const duration = services[state.type || "male"];
      const slots = await getAvailableSlots(state.date, duration);

      if (slots.length === 0) {
        reply = "אין תורים פנויים 😔";
      } else {
        reply = `הזמינות:\n👉 ${slots.slice(0,6).join(", ")}`;
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
