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

const BUSINESS_HOURS = {
  start: 16,
  end: 20,
  interval: 15,
};

// ====================== פונקציות ======================

function formatDateHebrew(dateStr) {
  const days = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];
  const date = new Date(dateStr);

  const dayName = days[date.getDay()];
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");

  return `יום ${dayName} ה-${day}/${month}`;
}

function extractTime(msg) {
  const match = msg.match(/\d{1,2}(:\d{1,2})?/);
  if (!match) return null;

  let [h, m = "00"] = match[0].split(":");
  let minute = parseInt(m);

  if (minute < 15) m = "00";
  else if (minute < 30) m = "15";
  else if (minute < 45) m = "30";
  else m = "45";

  return `${h.padStart(2, "0")}:${m}`;
}

function extractDate(msg) {
  const today = new Date();

  if (msg.includes("מחר")) {
    today.setDate(today.getDate() + 1);
  }

  return today.toISOString().split("T")[0];
}

function extractDay(msg) {
  const map = {
    "ראשון":0,"שני":1,"שלישי":2,"רביעי":3,"חמישי":4,"שישי":5,"שבת":6
  };

  for (let d in map) {
    if (msg.includes(d)) {
      const today = new Date();
      let diff = map[d] - today.getDay();
      if (diff <= 0) diff += 7;

      const result = new Date();
      result.setDate(today.getDate() + diff);

      return result.toISOString().split("T")[0];
    }
  }
  return null;
}

function generateSlots() {
  const slots = [];
  for (let h = BUSINESS_HOURS.start; h <= BUSINESS_HOURS.end; h++) {
    for (let m of ["00","15","30","45"]) {
      slots.push(`${String(h).padStart(2,"0")}:${m}`);
    }
  }
  return slots;
}

// ====================== מצב משתמש ======================

const userState = {};

// ====================== WEBHOOK ======================

app.post("/webhook", async (req, res) => {
  const msg = req.body.Body;
  const user = req.body.From;

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    if (!userState[user]) {
      userState[user] = {};
    }

    let state = userState[user];

    // ====================== ביטול ======================
    if (msg.includes("בטל")) {
      const snapshot = await db
        .collection("appointments")
        .where("user", "==", user)
        .get();

      if (snapshot.empty) {
        twiml.message("אין לך תור לבטל 🤔");
      } else {
        snapshot.forEach(doc => doc.ref.delete());
        twiml.message("התור בוטל בהצלחה ❌");
      }

      return res.end(twiml.toString());
    }

    // ====================== שינוי ======================
    if (msg.includes("שנה")) {
      state.step = "reschedule";
      twiml.message("איזה שעה חדשה תרצה?");
      return res.end(twiml.toString());
    }

    // ====================== זיהוי ======================
    if (!state.date) {
      const d = extractDay(msg) || extractDate(msg);
      if (d) state.date = d;
    }

    if (!state.time) {
      const t = extractTime(msg);
      if (t) state.time = t;
    }

    if (!state.type) {
      if (msg.includes("גבר")) state.type = "male";
      if (msg.includes("אישה")) state.type = "female";
    }

    // ====================== שיחה חכמה ======================

    // התחלה
    if (!state.step) {
      state.step = "date";
      return res.end(twiml.message("לאיזה יום תרצה לקבוע תור? 📅").toString());
    }

    // תאריך
    if (state.step === "date") {
      if (!state.date) {
        return res.end(twiml.message("לא הבנתי את היום 🤔").toString());
      }
      state.step = "time";
      return res.end(twiml.message("איזה שעה נוחה לך? ⏰").toString());
    }

    // שעה
    if (state.step === "time") {
      if (!state.time) {
        return res.end(twiml.message("איזה שעה? 🙂").toString());
      }
      state.step = "type";
      return res.end(twiml.message("למי התור? גבר או אישה?").toString());
    }

    // סוג
    if (state.step === "type") {
      if (!state.type) {
        return res.end(twiml.message("גבר או אישה?").toString());
      }

      // בדיקה תפוס
      const existing = await db
        .collection("appointments")
        .where("date", "==", state.date)
        .where("time", "==", state.time)
        .get();

      if (!existing.empty) {
        return res.end(twiml.message("התור תפוס 😞 נסה שעה אחרת").toString());
      }

      // שמירה
      await db.collection("appointments").add({
        user,
        date: state.date,
        time: state.time,
        type: state.type,
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
    twiml.message("שגיאה זמנית 😔");
    res.end(twiml.toString());
  }
});

// ====================== תזכורות ======================

setInterval(async () => {
  const now = new Date();

  const snapshot = await db.collection("appointments").get();

  snapshot.forEach(async (doc) => {
    const data = doc.data();

    const appointmentTime = new Date(`${data.date}T${data.time}`);

    const diff = appointmentTime - now;

    const minutes = diff / 60000;

    // יום לפני
    if (minutes < 1440 && !data.reminder1) {
      await sendWhatsApp(data.user, `📅 תזכורת: יש לך תור מחר ב-${data.time}`);
      doc.ref.update({ reminder1: true });
    }

    // שעה לפני
    if (minutes < 60 && !data.reminder2) {
      await sendWhatsApp(data.user, `⏰ תזכורת: יש לך תור בעוד שעה`);
      doc.ref.update({ reminder2: true });
    }
  });

}, 60000);

// ====================== שליחה ======================

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

// ====================== שרת ======================

app.get("/", (req, res) => {
  res.send("Server running");
});

app.listen(process.env.PORT || 8080, () => {
  console.log("🚀 Server running");
});
