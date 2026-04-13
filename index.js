require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const axios = require("axios");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static("public"));

// ===== Firebase =====
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY))
  });
}
const db = admin.firestore();

// ===== עובדים =====
const workers = ["david", "moshe"];

// ===== שירותים =====
const services = {
  male: 15,
  female: 40,
  child: 20
};

// ===== שעות =====
const baseSlots = [
  "08:00","08:15","08:30","08:45",
  "09:00","09:15","09:30","09:45",
  "10:00","10:15","10:30","10:45",
  "16:00","16:15","16:30","16:45",
  "17:00","17:15","17:30","17:45",
  "18:00","18:15","18:30"
];

// ===== Twilio =====
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

// ===== Helpers =====
const toMinutes = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

const extractTime = (msg) => {
  const match = msg.match(/\d{1,2}(:\d{2})?/);
  if (!match) return null;
  let t = match[0];
  if (!t.includes(":")) t += ":00";
  return t.padStart(5, "0");
};

const extractDate = (msg) => {
  const d = new Date();
  if (msg.includes("מחר")) d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
};

const detectType = (msg) => {
  if (msg.includes("אישה")) return "female";
  if (msg.includes("ילד")) return "child";
  if (msg.includes("גבר")) return "male";
  return null;
};

// ===== בדיקת חפיפה =====
const isAvailable = async (date, time, duration, worker) => {

  const snapshot = await db
    .collection("appointments")
    .where("date", "==", date)
    .where("worker", "==", worker)
    .get();

  const start = toMinutes(time);
  const end = start + duration;

  for (let doc of snapshot.docs) {
    const a = doc.data();
    const s = toMinutes(a.time);
    const e = s + a.duration;

    if (start < e && end > s) return false;
  }

  return true;
};

// ===== State =====
const sessions = {};

// ===== WhatsApp webhook =====
app.post("/whatsapp", async (req, res) => {
  try {
    const msg = req.body.Body.toLowerCase();
    const user = req.body.From.replace("whatsapp:", "");

    if (!sessions[user]) sessions[user] = {};
    let s = sessions[user];

    const time = extractTime(msg);
    const date = extractDate(msg);
    const type = detectType(msg);

    if (date) s.date = date;
    if (time) s.time = time;
    if (type) s.type = type;

    let reply = "";

    if (msg.includes("היי") || msg.includes("שלום")) {
      reply = "היי 👋 רוצה לקבוע תור?";
      sessions[user] = {};
    }

    else if (msg.includes("תור") || msg.includes("כן")) {
      s.step = "worker";
      reply = "לאיזה ספר?\n👉 דוד / משה";
    }

    else if (s.step === "worker" && (msg.includes("דוד") || msg.includes("משה"))) {
      s.worker = msg.includes("דוד") ? "david" : "moshe";
      s.step = "type";
      reply = "למי התור?\n👉 גבר / אישה / ילד";
    }

    else if (s.step === "type" && s.type) {
      s.step = "time";
      reply = "איזה שעה?";
    }

    else if (s.step === "time" && s.time) {

      const duration = services[s.type];

      const free = await isAvailable(s.date, s.time, duration, s.worker);

      if (!free) {
        reply = "השעה תפוסה 😅 נסה שעה אחרת";
      } else {

        await db.collection("appointments").add({
          user,
          date: s.date,
          time: s.time,
          type: s.type,
          duration,
          worker: s.worker
        });

        reply = `🎉 נקבע תור ל-${s.date} ${s.time}`;
        delete sessions[user];
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

// ===== API =====
app.get("/appointments", async (req, res) => {
  const date = req.query.date;

  const snapshot = await db
    .collection("appointments")
    .where("date", "==", date)
    .get();

  const data = snapshot.docs.map(d => d.data());
  res.json(data);
});

app.delete("/appointments", async (req, res) => {
  const { date, time, worker } = req.body;

  const snapshot = await db
    .collection("appointments")
    .where("date", "==", date)
    .where("time", "==", time)
    .where("worker", "==", worker)
    .get();

  snapshot.forEach(async d => await d.ref.delete());

  res.send("deleted");
});

app.put("/appointments", async (req, res) => {
  const { oldDate, oldTime, newDate, newTime, worker } = req.body;

  const snapshot = await db
    .collection("appointments")
    .where("date", "==", oldDate)
    .where("time", "==", oldTime)
    .where("worker", "==", worker)
    .get();

  snapshot.forEach(async doc => {
    await doc.ref.update({
      date: newDate,
      time: newTime
    });
  });

  res.send("updated");
});

// ===== server =====
app.listen(8080, () => console.log("🚀 Server running"));
