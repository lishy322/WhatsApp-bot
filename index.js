require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ====================== פונקציות עזר ======================

// תאריך עברי יפה
function formatDateHebrew(dateStr) {
  const days = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const date = new Date(dateStr);

  const dayName = days[date.getDay()];
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");

  return `יום ${dayName} ה-${day}/${month}`;
}

// היום / מחר
function extractDate(msg) {
  const today = new Date();

  if (msg.includes("מחר")) {
    today.setDate(today.getDate() + 1);
  }

  return today.toISOString().split("T")[0];
}

// יום בשבוע
function extractDayFromText(msg) {
  const daysMap = {
    "ראשון": 0,
    "שני": 1,
    "שלישי": 2,
    "רביעי": 3,
    "חמישי": 4,
    "שישי": 5,
    "שבת": 6,
  };

  for (let day in daysMap) {
    if (msg.includes(day)) {
      const today = new Date();
      const currentDay = today.getDay();
      let targetDay = daysMap[day];

      let diff = targetDay - currentDay;
      if (diff <= 0) diff += 7;

      const result = new Date();
      result.setDate(today.getDate() + diff);

      return result.toISOString().split("T")[0];
    }
  }

  return null;
}

// זיהוי שעה חכם
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

// שעות זמינות (כל 15 דקות)
function generateSlots() {
  const slots = [];
  for (let h = 16; h <= 20; h++) {
    for (let m of ["00", "15", "30", "45"]) {
      slots.push(`${String(h).padStart(2, "0")}:${m}`);
    }
  }
  return slots;
}

// ====================== מצב שיחה ======================

const userState = {};

// ====================== ראוט ======================

app.post("/webhook", async (req, res) => {
  const incomingMsg = req.body.Body;
  const user = req.body.From;

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    if (!userState[user]) {
      userState[user] = {
        step: "start",
        date: null,
        time: null,
        type: null,
      };
    }

    let state = userState[user];
    let reply = "";

    const availableSlots = generateSlots();

    // ====================== זיהוי תאריך ======================
    const dayFromText = extractDayFromText(incomingMsg);

    if (incomingMsg.includes("היום") || incomingMsg.includes("מחר")) {
      state.date = extractDate(incomingMsg);
    } else if (dayFromText) {
      state.date = dayFromText;
    }

    // ====================== זיהוי שעה ======================
    const detectedTime = extractTime(incomingMsg);
    if (detectedTime) state.time = detectedTime;

    // ====================== זיהוי סוג ======================
    if (!state.type) {
      if (incomingMsg.includes("אישה")) state.type = "female";
      if (incomingMsg.includes("גבר")) state.type = "male";
    }

    // ====================== זרימת שיחה ======================

    if (state.step === "start") {
      reply = "שלום! 👋 רוצה לקבוע תור?";
      state.step = "ask_date";
    }

    else if (state.step === "ask_date") {
      if (!state.date) {
        reply = "לאיזה יום תרצה לקבוע תור?";
      } else {
        reply = "איזה שעה נוחה לך?";
        state.step = "ask_time";
      }
    }

    else if (state.step === "ask_time") {
      if (!state.time) {
        reply = `יש לי שעות פנויות:\n${availableSlots.slice(0, 6).join(", ")}`;
      } else {
        reply = "למי התור? גבר או אישה?";
        state.step = "ask_type";
      }
    }

    else if (state.step === "ask_type") {
      if (!state.type) {
        reply = "זה תור לגבר או אישה?";
      } else {

        // ====================== בדיקה ב-Firebase ======================

        const snapshot = await db
          .collection("appointments")
          .where("date", "==", state.date)
          .where("time", "==", state.time)
          .get();

        if (!snapshot.empty) {
          reply = `התור תפוס 😞\nבחר שעה אחרת`;
        } else {
          await db.collection("appointments").add({
            user,
            date: state.date,
            time: state.time,
            type: state.type,
            createdAt: new Date(),
          });

          const prettyDate = formatDateHebrew(state.date);

          reply = `🎉 נקבע תור ל-${prettyDate} בשעה ${state.time}`;

          delete userState[user];
        }
      }
    }

    else {
      reply = "לא הבנתי 😅 תנסה שוב";
      delete userState[user];
    }

    twiml.message(reply);
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());

  } catch (err) {
    console.error(err);
    twiml.message("שגיאה זמנית 😔 נסה שוב");
    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());
  }
});

// ====================== בדיקת שרת ======================

app.get("/", (req, res) => {
  res.send("Server is running");
});

// ====================== הפעלה ======================

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
