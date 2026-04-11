const express = require("express");
const admin = require("firebase-admin");
const twilio = require("twilio");

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

// ================= סלוטים לחסימה =================
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

// ================= שעות פנויות =================
async function getFreeSlots(date) {
  const snapshot = await db
    .collection("appointments")
    .where("date", "==", date)
    .get();

  const taken = [];
  snapshot.forEach(doc => taken.push(doc.data().time));

  return availableSlots.filter(t => !taken.includes(t)).slice(0, 3);
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

    const diffMinutes = (appointmentTime - now) / 60000;
    const diffHours = diffMinutes / 60;

    // יום לפני (~24 שעות)
    if (diffHours > 23 && diffHours < 25 && !data.remindedDay) {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: data.user,
        body: `📅 תזכורת: יש לך תור מחר בשעה ${data.time}`,
      });

      await doc.ref.update({ remindedDay: true });
    }

    // שעה לפני
    if (diffMinutes > 59 && diffMinutes < 61 && !data.remindedHour) {
      await client.messages.create({
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: data.user,
        body: `⏰ תזכורת: יש לך תור בעוד שעה (${data.time})`,
      });

      await doc.ref.update({ remindedHour: true });
    }
  });
}

setInterval(sendReminders, 60000);

// ================= WHATSAPP =================
app.post("/whatsapp", async (req, res) => {
  const incomingMsg = req.body.Body;
  const user = req.body.From;

  let state = await getUserState(user);
  let reply = "";

  const today = new Date().toISOString().split("T")[0];

  // ================= בדיקת תור קיים =================
  const existing = await db
    .collection("appointments")
    .where("user", "==", user)
    .where("date", ">=", today)
    .limit(1)
    .get();

  const hasAppointment = !existing.empty;
  let groupId = null;

  if (hasAppointment) {
    groupId = existing.docs[0].data().groupId;
  }

  // ================= ביטול =================
  if (incomingMsg.includes("לבטל") && hasAppointment) {
    const snapshot = await db
      .collection("appointments")
      .where("groupId", "==", groupId)
      .get();

    snapshot.forEach(doc => doc.ref.delete());

    await setUserState(user, {});
    reply = "התור בוטל ❌";
  }

  // ================= שינוי =================
  else if (incomingMsg.includes("לשנות") && hasAppointment) {
    state.mode = "reschedule";
    reply = "לאיזה יום תרצה לקבוע?";
  }

  // ================= התחלה =================
  else if (!state.date) {
    reply = hasAppointment
      ? `יש לך תור קיים 🙂 רוצה לשנות או לבטל?`
      : "היי 👋 רוצה לקבוע תור? לאיזה יום?";
  }

  // ================= יום =================
  else if (!state.time) {
    const free = await getFreeSlots(state.date);
    reply = `יש לי כמה שעות פנויות:\n${free.join(", ")}\nמה מתאים לך?`;
  }

  // ================= סוג =================
  else if (!state.type) {
    reply = "למי התור? גבר או אישה?";
  }

  // ================= קביעה =================
  else {
    const duration = getDuration(state.type);
    const slots = getSlotsToBlock(state.time, duration);
    const newGroupId = Date.now().toString();

    const snapshot = await db
      .collection("appointments")
      .where("date", "==", state.date)
      .get();

    let taken = false;

    snapshot.forEach(doc => {
      if (slots.includes(doc.data().time)) taken = true;
    });

    if (taken) {
      reply = "התור תפוס 😞 נסה שעה אחרת";
    } else {
      // מחיקה אם שינוי
      if (state.mode === "reschedule" && groupId) {
        const old = await db
          .collection("appointments")
          .where("groupId", "==", groupId)
          .get();

        old.forEach(doc => doc.ref.delete());
      }

      for (let t of slots) {
        await db.collection("appointments").add({
          user,
          time: t,
          date: state.date,
          groupId: newGroupId,
          remindedDay: false,
          remindedHour: false,
        });
      }

      reply = `🎉 התור נקבע ל-${state.time}`;
      await setUserState(user, {});
    }
  }

  // ================= עדכון STATE =================
  if (incomingMsg.includes("היום") || incomingMsg.includes("מחר")) {
    state.date = extractDate(incomingMsg);
  }

  if (incomingMsg.match(/\d{1,2}/)) {
    const hour = incomingMsg.match(/\d{1,2}/)[0];
    state.time = `${hour.padStart(2, "0")}:00`;
  }

  if (incomingMsg.includes("אישה")) state.type = "female";
  if (incomingMsg.includes("גבר")) state.type = "male";

  await setUserState(user, state);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

// ================= SERVER =================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running"));
