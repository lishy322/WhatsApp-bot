require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/* ================= FIREBASE ================= */
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

/* ================= TWILIO ================= */
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/* ================= OPENAI ================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ================= הגדרות ================= */

const services = {
  "גבר": 15,
  "ילד": 20,
  "אישה": 40,
};

const workers = ["דוד", "משה"];

/* ================= זיכרון ================= */

const sessions = {};

/* ================= תאריכים ================= */

function getNextDayOfWeek(dayName) {
  const daysMap = {
    "ראשון": 0,
    "שני": 1,
    "שלישי": 2,
    "רביעי": 3,
    "חמישי": 4,
    "שישי": 5,
    "שבת": 6
  };

  const targetDay = daysMap[dayName];
  if (targetDay === undefined) return null;

  const now = new Date();
  const today = now.getDay();

  let diff = targetDay - today;
  if (diff <= 0) diff += 7;

  const result = new Date();
  result.setDate(now.getDate() + diff);

  return result.toISOString().split("T")[0];
}

/* ================= שעות פנויות ================= */

function generateSlots() {
  const slots = [];
  for (let h = 8; h <= 18; h++) {
    for (let m = 0; m < 60; m += 15) {
      if (h === 18 && m > 0) continue;
      slots.push(
        String(h).padStart(2, "0") +
        ":" +
        String(m).padStart(2, "0")
      );
    }
  }
  return slots;
}

/* ================= בדיקת תפוס ================= */

async function isSlotTaken(date, time, duration, worker) {
  const snapshot = await db.collection("appointments")
    .where("date", "==", date)
    .where("worker", "==", worker)
    .get();

  const [hour, minute] = time.split(":").map(Number);

  for (const doc of snapshot.docs) {
    const appt = doc.data();
    const dur = services[appt.type] || 15;

    const [h, m] = appt.time.split(":").map(Number);

    const start = h * 60 + m;
    const end = start + dur;

    const newStart = hour * 60 + minute;
    const newEnd = newStart + duration;

    if (newStart < end && newEnd > start) {
      return true;
    }
  }

  return false;
}

/* ================= שליחת וואטסאפ ================= */

async function sendWhatsApp(to, message) {
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: to,
    body: message,
  });
}

/* ================= webhook ================= */

app.post("/whatsapp", async (req, res) => {
  const msg = req.body.Body.trim();
  const from = req.body.From;

  if (!sessions[from]) {
    sessions[from] = {};
  }

  const session = sessions[from];

  try {

    /* התחלה */
    if (!session.step) {
      session.step = "start";
      await sendWhatsApp(from, "היי 👋 רוצה לקבוע תור?");
      return res.send("ok");
    }

    /* התחלה → כן */
    if (session.step === "start" && msg.includes("כן")) {
      session.step = "worker";
      await sendWhatsApp(from, "לאיזה ספר?\n👉 דוד / משה");
      return res.send("ok");
    }

    /* בחירת ספר */
    if (session.step === "worker") {
      if (workers.includes(msg)) {
        session.worker = msg;
        session.step = "type";
        await sendWhatsApp(from, "למי התור?\n👉 גבר / אישה / ילד");
      }
      return res.send("ok");
    }

    /* סוג */
    if (session.step === "type") {
      if (services[msg]) {
        session.type = msg;
        session.step = "date";
        await sendWhatsApp(from, "לאיזה יום? 📅\nאפשר: מחר / יום שלישי");
      }
      return res.send("ok");
    }

    /* תאריך */
    if (session.step === "date") {

      let selectedDate = null;

      if (msg.includes("מחר")) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        selectedDate = d.toISOString().split("T")[0];
      }

      else if (msg.includes("יום")) {
        const match = msg.match(/יום\s(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
        if (match) {
          selectedDate = getNextDayOfWeek(match[1]);
        }
      }

      if (!selectedDate) {
        await sendWhatsApp(from, "לא הבנתי את התאריך 😅");
        return res.send("ok");
      }

      session.date = selectedDate;
      session.step = "time";

      const slots = generateSlots();
      await sendWhatsApp(from, `איזה שעה ל-${selectedDate}? \n${slots.slice(32, 40).join(", ")}`);

      return res.send("ok");
    }

    /* שעה */
    if (session.step === "time") {

      let time = msg.length <= 2 ? msg + ":00" : msg;

      const duration = services[session.type];

      const taken = await isSlotTaken(session.date, time, duration, session.worker);

      if (taken) {
        await sendWhatsApp(from, "השעה תפוסה 😅 נסה אחרת");
        return res.send("ok");
      }

      await db.collection("appointments").add({
        user: from,
        date: session.date,
        time: time,
        type: session.type,
        worker: session.worker,
        createdAt: new Date()
      });

      await sendWhatsApp(from, `🎉 נקבע תור ל-${session.date} בשעה ${time}`);

      sessions[from] = {};
      return res.send("ok");
    }

  } catch (err) {
    console.error(err);
  }

  res.send("ok");
});

/* ================= UI API ================= */

app.get("/appointments/week", async (req, res) => {
  const snapshot = await db.collection("appointments").get();

  const appointments = snapshot.docs.map(doc => doc.data());
  const result = [];

  for (const appt of appointments) {
    const duration = services[appt.type] || 15;

    const [hour, minute] = appt.time.split(":").map(Number);
    const blocks = Math.ceil(duration / 15);

    for (let i = 0; i < blocks; i++) {
      let m = minute + i * 15;
      let h = hour;

      if (m >= 60) {
        h += Math.floor(m / 60);
        m = m % 60;
      }

      const timeStr =
        String(h).padStart(2, "0") +
        ":" +
        String(m).padStart(2, "0");

      result.push({
        date: appt.date,
        time: timeStr,
        type: appt.type,
        worker: appt.worker
      });
    }
  }

  res.json(result);
});

/* ================= ROOT ================= */

app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

/* ================= SERVER ================= */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
