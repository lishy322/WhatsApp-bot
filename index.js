require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const twilio = require("twilio");
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

/* ================= הגדרות ================= */

const services = {
  "גבר": 15,
  "ילד": 20,
  "אישה": 40,
};

const workers = ["דוד", "משה"];
const sessions = {};

/* ================= תאריך חכם ================= */

function getNextDayOfWeek(dayName) {
  const map = {
    "ראשון": 0,
    "שני": 1,
    "שלישי": 2,
    "רביעי": 3,
    "חמישי": 4,
    "שישי": 5,
    "שבת": 6,
  };

  const target = map[dayName];
  if (target === undefined) return null;

  const now = new Date();
  const today = now.getDay();

  let diff = target - today;
  if (diff <= 0) diff += 7;

  const d = new Date();
  d.setDate(now.getDate() + diff);

  return d.toISOString().split("T")[0];
}

/* ================= בדיקת חפיפה ================= */

async function isTaken(date, time, duration, worker) {
  const snapshot = await db.collection("appointments")
    .where("date", "==", date)
    .where("worker", "==", worker)
    .get();

  const [h, m] = time.split(":").map(Number);
  const start = h * 60 + m;
  const end = start + duration;

  for (const doc of snapshot.docs) {
    const a = doc.data();
    const dur = services[a.type] || 15;

    const [hh, mm] = a.time.split(":").map(Number);
    const s = hh * 60 + mm;
    const e = s + dur;

    if (start < e && end > s) return true;
  }

  return false;
}

/* ================= שליחת הודעה ================= */

async function send(to, text) {
  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body: text,
  });
}

/* ================= BOT ================= */

app.post("/whatsapp", async (req, res) => {
  const msg = req.body.Body.trim();
  const from = req.body.From;

  if (!sessions[from]) sessions[from] = {};
  const s = sessions[from];

  try {

    if (!s.step) {
      s.step = "start";
      await send(from, "היי 👋 רוצה לקבוע תור?");
      return res.send("ok");
    }

    if (s.step === "start") {
      s.step = "worker";
      return send(from, "לאיזה ספר?\n👉 דוד / משה");
    }

    if (s.step === "worker") {
      if (workers.includes(msg)) {
        s.worker = msg;
        s.step = "type";
        return send(from, "למי התור?\n👉 גבר / אישה / ילד");
      }
      return send(from, "בחר: דוד או משה");
    }

    if (s.step === "type") {
      if (services[msg]) {
        s.type = msg;
        s.step = "date";
        return send(from, "לאיזה יום?\n👉 מחר / יום רביעי");
      }
      return send(from, "כתוב: גבר / אישה / ילד");
    }

    if (s.step === "date") {
      let date = null;

      if (msg.includes("מחר")) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        date = d.toISOString().split("T")[0];
      } else if (msg.includes("יום")) {
        const match = msg.match(/יום\s(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
        if (match) date = getNextDayOfWeek(match[1]);
      }

      if (!date) return send(from, "לא הבנתי תאריך 😅");

      s.date = date;
      s.step = "time";
      return send(from, `איזה שעה ל-${date}?`);
    }

    if (s.step === "time") {
      let time = msg.length <= 2 ? msg + ":00" : msg;

      const taken = await isTaken(
        s.date,
        time,
        services[s.type],
        s.worker
      );

      if (taken) return send(from, "השעה תפוסה 😅");

      await db.collection("appointments").add({
        user: from,
        date: s.date,
        time,
        type: s.type,
        worker: s.worker,
      });

      await send(from, `🎉 נקבע תור ל-${s.date} בשעה ${time}`);
      sessions[from] = {};
    }

  } catch (e) {
    console.error(e);
  }

  res.send("ok");
});

/* ================= API ================= */

app.get("/appointments/week", async (req, res) => {
  const snapshot = await db.collection("appointments").get();
  res.json(snapshot.docs.map(d => d.data()));
});

/* ================= ROOT ================= */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ================= SERVER ================= */

app.listen(8080, () => console.log("🚀 עובד"));
