const express = require("express");
const admin = require("firebase-admin");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();
app.use(express.urlencoded({ extended: false }));

// ================= FIREBASE =================
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ================= TWILIO =================
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ================= OPENAI =================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================= סלוטים =================
function generateSlots(start, end) {
  const slots = [];
  let current = new Date(`1970-01-01T${start}:00`);
  const finish = new Date(`1970-01-01T${end}:00`);

  while (current <= finish) {
    const h = current.getHours().toString().padStart(2, "0");
    const m = current.getMinutes().toString().padStart(2, "0");
    slots.push(`${h}:${m}`);
    current.setMinutes(current.getMinutes() + 15);
  }

  return slots;
}

const availableSlots = generateSlots("16:00", "20:00");

// ================= תאריך =================
function extractDate(msg) {
  const today = new Date();

  if (msg.includes("מחר")) {
    today.setDate(today.getDate() + 1);
  }

  return today.toISOString().split("T")[0];
}

// ================= משך טיפול =================
function getDuration(type) {
  return type === "female" ? 45 : 15;
}

// ================= חסימת סלוטים =================
function getSlotsToBlock(startTime, duration) {
  const result = [];
  let [hour, minute] = startTime.split(":").map(Number);

  let total = 0;

  while (total < duration) {
    result.push(
      `${hour.toString().padStart(2, "0")}:${minute
        .toString()
        .padStart(2, "0")}`
    );

    minute += 15;
    if (minute >= 60) {
      minute = 0;
      hour += 1;
    }

    total += 15;
  }

  return result;
}

// ================= STATE =================
async function getUserState(user) {
  const doc = await db.collection("sessions").doc(user).get();
  return doc.exists ? doc.data() : {};
}

async function setUserState(user, data) {
  await db.collection("sessions").doc(user).set(data, { merge: true });
}

// ================= תזכורות =================
async function sendReminders() {
  const now = new Date();

  const snapshot = await db.collection("appointments").get();

  snapshot.forEach(async (doc) => {
    const data = doc.data();

    const appointmentTime = new Date(`${data.date}T${data.time}:00`);
    const diff = (appointmentTime - now) / 60000;

    if (diff > 29 && diff < 31 && !data.reminded) {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: data.user,
        body: `⏰ תזכורת: יש לך תור היום ב-${data.time}`,
      });

      await doc.ref.update({ reminded: true });
    }
  });
}

setInterval(sendReminders, 60000);

// ================= WHATSAPP =================
app.post("/whatsapp", async (req, res) => {
  const incomingMsg = req.body.Body;
  const user = req.body.From;

  let reply = "";
  let state = await getUserState(user);

  // ================= זיהוי שעה =================
  let timeMatch = incomingMsg.match(/\d{1,2}(:\d{1,2})?/);
  if (timeMatch) {
    let t = timeMatch[0];

    let [h, m = "00"] = t.split(":");
    let minute = parseInt(m);

    if (minute < 15) m = "00";
    else if (minute < 30) m = "15";
    else if (minute < 45) m = "30";
    else m = "45";

    state.time = `${h.padStart(2, "0")}:${m}`;
  }

  // ================= סוג שירות =================
  if (incomingMsg.includes("אישה")) state.type = "female";
  if (incomingMsg.includes("גבר")) state.type = "male";

  // ================= תאריך =================
  const date = extractDate(incomingMsg);
  state.date = date;

  // ================= לוגיקה =================

  if (!state.time) {
    reply = `איזה שעה נוחה לך?\n${availableSlots.join(", ")}`;
  }

  else if (!state.type) {
    reply = "למי התור? גבר או אישה? 🙂";
  }

  else {
    try {
      const duration = getDuration(state.type);
      const slotsNeeded = getSlotsToBlock(state.time, duration);

      const snapshot = await db
        .collection("appointments")
        .where("date", "==", state.date)
        .get();

      let isTaken = false;

      snapshot.forEach((doc) => {
        if (slotsNeeded.includes(doc.data().time)) {
          isTaken = true;
        }
      });

      if (isTaken) {
        reply = `התור מתנגש 😞\nבחר שעה אחרת:\n${availableSlots.join(", ")}`;
      } else {
        for (let t of slotsNeeded) {
          await db.collection("appointments").add({
            user,
            time: t,
            date: state.date,
            reminded: false,
            createdAt: new Date(),
          });
        }

        reply = `🎉 התור נקבע ל-${state.time}`;
        await setUserState(user, {}); // איפוס
      }

    } catch (err) {
      console.log(err);
      reply = "שגיאה זמנית 😔 נסה שוב";
    }
  }

  await setUserState(user, state);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

// ================= SERVER =================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running"));
