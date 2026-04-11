const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ====================== הגדרות ======================
const BUSINESS_HOURS = { start: 16, end: 20 };

// ====================== פונקציות ======================

function formatDateHebrew(dateStr) {
  const days = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];
  const d = new Date(dateStr);
  return `יום ${days[d.getDay()]} ה-${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}`;
}

function extractTime(msg) {
  const m = msg.match(/\d{1,2}(:\d{1,2})?/);
  if (!m) return null;

  let [h, min="00"] = m[0].split(":");
  let minute = parseInt(min);

  if (minute < 15) min = "00";
  else if (minute < 30) min = "15";
  else if (minute < 45) min = "30";
  else min = "45";

  return `${h.padStart(2,"0")}:${min}`;
}

function extractDate(msg) {
  const today = new Date();
  if (msg.includes("מחר")) today.setDate(today.getDate()+1);
  return today.toISOString().split("T")[0];
}

function extractDay(msg) {
  const map = {"ראשון":0,"שני":1,"שלישי":2,"רביעי":3,"חמישי":4,"שישי":5,"שבת":6};
  for (let d in map) {
    if (msg.includes(d)) {
      const today = new Date();
      let diff = map[d] - today.getDay();
      if (diff <= 0) diff += 7;
      const result = new Date();
      result.setDate(today.getDate()+diff);
      return result.toISOString().split("T")[0];
    }
  }
  return null;
}

async function sendWhatsApp(to, body) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body,
  });
}

// ====================== מצב משתמש ======================
const userState = {};

// ====================== WEBHOOK ======================
app.post("/webhook", async (req, res) => {
  const msg = req.body.Body.trim();
  const user = req.body.From;

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    if (!userState[user] || msg === "היי") {
      userState[user] = { step: "date" };
      return res.end(
        twiml.message("לאיזה יום תרצה לקבוע תור? 📅").toString()
      );
    }

    let state = userState[user];

    // ביטול
    if (msg.includes("בטל")) {
      const snap = await db.collection("appointments").where("user","==",user).get();
      if (snap.empty) {
        return res.end(twiml.message("אין לך תור לבטל").toString());
      }
      snap.forEach(d => d.ref.delete());
      return res.end(twiml.message("התור בוטל ❌").toString());
    }

    // זיהוי נתונים
    if (!state.date) state.date = extractDay(msg) || extractDate(msg);
    if (!state.time) state.time = extractTime(msg);
    if (!state.type) {
      if (msg.includes("גבר")) state.type = "male";
      if (msg.includes("אישה")) state.type = "female";
    }

    // שלבים
    if (state.step === "date") {
      if (!state.date) return res.end(twiml.message("איזה יום? 🙂").toString());
      state.step = "time";
      return res.end(twiml.message("איזה שעה? ⏰").toString());
    }

    if (state.step === "time") {
      if (!state.time) return res.end(twiml.message("לא הבנתי שעה 🤔").toString());
      state.step = "type";
      return res.end(twiml.message("למי התור? גבר או אישה?").toString());
    }

    if (state.step === "type") {
      if (!state.type) return res.end(twiml.message("גבר או אישה?").toString());

      const existing = await db
        .collection("appointments")
        .where("date","==",state.date)
        .where("time","==",state.time)
        .get();

      if (!existing.empty) {
        return res.end(twiml.message("התור תפוס 😞").toString());
      }

      await db.collection("appointments").add({
        user,
        date: state.date,
        time: state.time,
        reminder1: false,
        reminder2: false,
      });

      const pretty = formatDateHebrew(state.date);

      delete userState[user];

      return res.end(
        twiml.message(`🎉 נקבע תור ל-${pretty} בשעה ${state.time}`).toString()
      );
    }

  } catch (err) {
    console.error(err);
    return res.end(twiml.message("שגיאה 😔").toString());
  }
});

// ====================== תזכורות ======================

app.get("/run-reminders", async (req, res) => {
  try {
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
        await sendWhatsApp(data.user, `⏰ תזכורת: התור בעוד שעה`);
        await doc.ref.update({ reminder2: true });
      }
    }

    res.send("OK");

  } catch (err) {
    console.error("REMINDER ERROR:", err);
    res.status(500).send("error");
  }
});

// ====================== שרת ======================

app.get("/", (req, res) => {
  res.send("Server running");
});

app.listen(process.env.PORT || 8080, () => {
  console.log("🚀 Server running");
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
