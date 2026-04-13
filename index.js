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

// ===== helpers =====
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

const detectType = (msg) => {
  if (msg.includes("אישה")) return "female";
  if (msg.includes("ילד")) return "child";
  if (msg.includes("גבר")) return "male";
  return null;
};

// ===== state =====
const sessions = {};

// ===== WhatsApp =====
app.post("/whatsapp", async (req, res) => {
  try {
    const msg = req.body.Body.toLowerCase();
    const user = req.body.From.replace("whatsapp:", "");

    if (!sessions[user]) sessions[user] = {};
    let s = sessions[user];

    const time = extractTime(msg);
    const date = extractDate(msg);
    const type = detectType(msg);

    if (time) s.time = time;
    if (date) s.date = date;
    if (type) s.type = type;

    let reply = "";

    // התחלה
    if (msg.includes("היי") || msg.includes("שלום")) {
      sessions[user] = {};
      reply = "היי 👋 רוצה לקבוע תור?";
    }

    // התחלת תהליך
    else if (msg.includes("תור") || msg.includes("כן")) {
      s.step = "worker";
      reply = "לאיזה ספר?\n👉 דוד / משה";
    }

    // עובד
    else if (s.step === "worker" && (msg.includes("דוד") || msg.includes("משה"))) {
      s.worker = msg.includes("דוד") ? "david" : "moshe";
      s.step = "type";
      reply = "למי התור?\n👉 גבר / אישה / ילד";
    }

    // סוג
    else if (s.step === "type" && s.type) {
      s.step = "date";
      reply = "לאיזה יום? 📅\nאפשר לכתוב: מחר / יום שלישי / תאריך";
    }

    // תאריך
    else if (s.step === "date" && s.date) {
      s.step = "time";
      reply = "איזה שעה?";
    }

    // שעה וסגירה
    else if (s.step === "time" && s.time) {

      await db.collection("appointments").add({
        user,
        date: s.date,
        time: s.time,
        type: s.type,
        worker: s.worker
      });

      reply = `🎉 נקבע תור ל-${s.date} בשעה ${s.time}`;
      delete sessions[user];
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

// כל התורים
app.get("/appointments/week", async (req, res) => {
  try {
    const snapshot = await db.collection("appointments").get();

    const data = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json(data);

  } catch (err) {
    console.error(err);
    res.status(500).send("error");
  }
});

// יצירה מה UI
app.post("/appointments", async (req, res) => {
  await db.collection("appointments").add(req.body);
  res.send("OK");
});

// ביטול
app.delete("/appointments", async (req, res) => {
  const { date, time, worker } = req.body;

  const snapshot = await db.collection("appointments")
    .where("date","==",date)
    .where("time","==",time)
    .where("worker","==",worker)
    .get();

  snapshot.forEach(doc => doc.ref.delete());

  res.send("deleted");
});

// שינוי
app.put("/appointments", async (req, res) => {
  const { oldDate, oldTime, newDate, newTime, worker } = req.body;

  const snapshot = await db.collection("appointments")
    .where("date","==",oldDate)
    .where("time","==",oldTime)
    .where("worker","==",worker)
    .get();

  snapshot.forEach(doc => {
    doc.ref.update({
      date:newDate,
      time:newTime
    });
  });

  res.send("updated");
});

// ===== root =====
app.get("/", (req,res)=>{
  res.sendFile(__dirname + "/public/index.html");
});

// ===== server =====
app.listen(8080, () => console.log("🚀 Server running"));
