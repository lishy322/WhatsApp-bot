require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const twilio = require("twilio");
const OpenAI = require("openai");
const path = require("path");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

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

/* ================= slots ================= */

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

/* ================= בדיקת חפיפה ================= */

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

/* ================= whatsapp ================= */

async function sendWhatsApp(to, message) {
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: to,
    body: message,
  });
}

/* ================= BOT ================= */

app.post("/whatsapp", async (req, res) => {
  const msg = req.body.Body.trim();
  const from = req.body.From;

  if (!sessions[from]) sessions[from] = {};
  const session = sessions[from];

  try {

    if (!session.step) {
      session.step = "start";
      await sendWhatsApp(from, "היי 👋 רוצה לקבוע תור?");
      return res.send("ok");
    }

    if (session.step === "start" && msg.includes("כן")) {
      session.step = "worker";
      return sendWhatsApp(from, "לאיזה ספר?\n👉 דוד / משה");
    }

    if (session.step === "worker") {
      if (workers.includes(msg)) {
        session.worker = msg;
        session.step = "type";
        return sendWhatsApp(from, "למי התור?\n👉 גבר / אישה / ילד");
      }
    }

    if (session.step === "type") {
      if (services[msg]) {
        session.type = msg;
        session.step = "date";
        return sendWhatsApp(from, "לאיזה יום? 📅\nמחר / יום שלישי");
      }
    }

    if (session.step === "date") {
      let selectedDate = null;

      if (msg.includes("מחר")) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        selectedDate = d.toISOString().split("T")[0];
      } else if (msg.includes("יום")) {
        const match = msg.match(/יום\s(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
        if (match) selectedDate = getNextDayOfWeek(match[1]);
      }

      if (!selectedDate) {
        return sendWhatsApp(from, "לא הבנתי תאריך 😅");
      }

      session.date = selectedDate;
      session.step = "time";

      return sendWhatsApp(from, `איזה שעה ל-${selectedDate}?`);
    }

    if (session.step === "time") {
      let time = msg.length <= 2 ? msg + ":00" : msg;

      const taken = await isSlotTaken(
        session.date,
        time,
        services[session.type],
        session.worker
      );

      if (taken) {
        return sendWhatsApp(from, "השעה תפוסה 😅");
      }

      await db.collection("appointments").add({
        user: from,
        date: session.date,
        time,
        type: session.type,
        worker: session.worker
      });

      await sendWhatsApp(from, `🎉 נקבע תור ל-${session.date} ${time}`);

      sessions[from] = {};
    }

  } catch (err) {
    console.error(err);
  }

  res.send("ok");
});

/* ================= UI API ================= */

app.get("/appointments/week", async (req, res) => {
  const snapshot = await db.collection("appointments").get();
  res.json(snapshot.docs.map(d => d.data()));
});

/* ================= ROOT ================= */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("🚀 Running"));
