require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static("public"));

// ===== Firebase =====
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ===== OpenAI =====
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== Twilio =====
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM = `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`;

// ===== שעות =====
const baseSlots = [
  "08:00","08:15","08:30","08:45",
  "09:00","09:15","09:30","09:45",
  "10:00","10:15","10:30","10:45",
  "16:00","16:15","16:30","16:45",
  "17:00","17:15","17:30","17:45",
  "18:00","18:15","18:30"
];

// ===== זיכרון =====
const sessions = {};

// ===== עזר =====
function normalizeTime(text) {
  const match = text.match(/(\d{1,2})(?::(\d{2}))?/);
  if (!match) return null;

  let h = match[1].padStart(2, "0");
  let m = match[2] || "00";

  return `${h}:${m}`;
}

function getToday() {
  const d = new Date();
  return d.toISOString().split("T")[0];
}

// ===== בדיקת זמינות =====
async function isAvailable(date, time) {
  const snapshot = await db
    .collection("appointments")
    .where("date", "==", date)
    .where("time", "==", time)
    .get();

  return snapshot.empty;
}

// ===== שמירת תור =====
async function saveAppointment(user, date, time, type) {
  await db.collection("appointments").add({
    user,
    date,
    time,
    type,
    createdAt: new Date()
  });
}

// ===== שליחת וואטסאפ =====
async function sendWhatsApp(to, body) {
  try {
    await client.messages.create({
      from: FROM,
      to,
      body
    });
  } catch (err) {
    console.error("TWILIO ERROR:", err.message);
  }
}

// ===== AI =====
async function askAI(text) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: text }],
    });

    return res.choices[0].message.content;
  } catch (err) {
    return null;
  }
}

// ===== Webhook =====
app.post("/whatsapp", async (req, res) => {
  const incoming = req.body.Body.toLowerCase();
  const user = req.body.From;

  if (!sessions[user]) {
    sessions[user] = {};
  }

  let session = sessions[user];

  // ===== זיהוי תור =====
  if (incoming.includes("תור")) {
    session.intent = "book";
    return sendWhatsApp(user, "מעולה 👍 איזה שעה נוחה לך?");
  }

  // ===== זמן =====
  const time = normalizeTime(incoming);
  if (time) {
    session.time = time;
    session.date = session.date || getToday();

    return sendWhatsApp(user, "למי התור? גבר / אישה / ילד");
  }

  // ===== סוג =====
  if (incoming.includes("גבר") || incoming.includes("אישה") || incoming.includes("ילד")) {
    session.type = incoming.includes("גבר") ? "male"
      : incoming.includes("אישה") ? "female"
      : "child";

    const free = await isAvailable(session.date, session.time);

    if (!free) {
      return sendWhatsApp(user, "❌ השעה תפוסה, בחר שעה אחרת");
    }

    await saveAppointment(user, session.date, session.time, session.type);

    sendWhatsApp(user, `🎉 נקבע תור ל-${session.date} בשעה ${session.time}`);

    sessions[user] = {};
    return;
  }

  // ===== fallback AI =====
  const ai = await askAI(incoming);

  if (ai) {
    return sendWhatsApp(user, ai);
  }

  return sendWhatsApp(user, "לא הבנתי 😅 רוצה לקבוע תור?");
});

// ===== API ליומן =====
app.get("/appointments", async (req, res) => {
  const date = req.query.date;

  if (!date) return res.json([]);

  const snapshot = await db
    .collection("appointments")
    .where("date", "==", date)
    .get();

  const data = snapshot.docs.map(doc => doc.data());

  res.json(data);
});

// ===== תזכורות =====
app.get("/run-reminders", async (req, res) => {
  const now = new Date();

  const snapshot = await db.collection("appointments").get();

  for (const doc of snapshot.docs) {
    const data = doc.data();

    const appt = new Date(`${data.date}T${data.time}`);
    const diff = (appt - now) / 60000;

    if (diff < 1440 && !data.reminder1) {
      await sendWhatsApp(data.user, `📅 תזכורת: מחר יש לך תור ב-${data.time}`);
      await doc.ref.update({ reminder1: true });
    }

    if (diff < 60 && !data.reminder2) {
      await sendWhatsApp(data.user, `⏰ תזכורת: התור בעוד שעה`);
      await doc.ref.update({ reminder2: true });
    }
  }

  res.send("OK");
});

// ===== root =====
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// ===== run =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Server running"));
