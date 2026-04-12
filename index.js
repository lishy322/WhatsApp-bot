const express = require("express");
const bodyParser = require("body-parser");
const { MessagingResponse } = require("twilio").twiml;
const admin = require("firebase-admin");
const OpenAI = require("openai");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// ================= FIREBASE =================
let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (e) {
  console.error("❌ FIREBASE KEY ERROR:", e);
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

const userState = {};

// ================= OPENAI =================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================= SERVER =================
app.get("/", (req, res) => {
  res.send("Server is running 🚀");
});

// ================= WHATSAPP =================
app.post("/whatsapp", async (req, res) => {
  console.log("📩 webhook triggered");

  let reply = "משהו השתבש 😅";

  try {
    const incomingMsg = req.body.Body?.trim();
    const user = req.body.From;

    if (!userState[user]) {
      userState[user] = {};
    }

    let state = userState[user];

    // התחלה
    if (incomingMsg === "היי") {
      userState[user] = {};
      reply = "שלום 👋 רוצה לקבוע תור?";
    }

    // כן
    else if (incomingMsg.includes("כן")) {
      state.step = "date";
      reply = "לאיזה יום תרצה לקבוע תור?";
    }

    // יום
    else if (state.step === "date") {
      state.date = incomingMsg;
      state.step = "time";
      reply = "איזה שעה נוחה לך?";
    }

    // שעה
    else if (state.step === "time") {
      const match = incomingMsg.match(/\d{1,2}/);

      if (!match) {
        reply = "לא הבנתי שעה 😅 נסה למשל 17";
      } else {
        state.time = match[0].padStart(2, "0") + ":00";
        state.step = "type";
        reply = "למי התור? גבר או אישה?";
      }
    }

    // סוג
    else if (state.step === "type") {
      const type = incomingMsg.includes("אישה") ? "female" : "male";

      await db.collection("appointments").add({
        user,
        date: state.date,
        time: state.time,
        type,
        createdAt: new Date(),
      });

      reply = `🎉 נקבע תור ל-${state.date} בשעה ${state.time}`;

      delete userState[user];
    }

    else {
      reply = "אפשר לכתוב: אני רוצה לקבוע תור 🙂";
    }

  } catch (err) {
    console.error("❌ ERROR:", err);
    reply = "שגיאה זמנית 😔";
  }

  const twiml = new MessagingResponse();
  twiml.message(reply);

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});
    // ================= לוגיקה =================
    const availableSlots = ["16:00", "17:00", "18:00"];

    // תאריך
    let date = data.day || new Date().toISOString().split("T")[0];

    // greeting
    if (data.intent === "greeting") {
      reply = "שלום 👋 רוצה לקבוע תור?";
    }

    // התחלת קביעה
    else if (data.intent === "book") {
      if (!data.time) {
        reply = `איזה שעה נוחה לך?\n${availableSlots.join(", ")}`;
      }

      else if (!availableSlots.includes(data.time)) {
        reply = `השעה לא זמינה 😅\nבחר מתוך:\n${availableSlots.join(", ")}`;
      }

      else {
        // בדיקה אם תפוס
        const snapshot = await db
          .collection("appointments")
          .where("date", "==", date)
          .where("time", "==", data.time)
          .get();

        if (!snapshot.empty) {
          reply = `התור תפוס 😞\nבחר שעה אחרת:\n${availableSlots.join(", ")}`;
        } else {
          // שמירה
          await db.collection("appointments").add({
            user,
            time: data.time,
            date,
            createdAt: new Date(),
          });

          const d = new Date(date);
          const formatted = `${d.getDate().toString().padStart(2, "0")}/${(d.getMonth()+1)
            .toString()
            .padStart(2, "0")}`;

          reply = `🎉 נקבע תור ל-${formatted} בשעה ${data.time}`;
        }
      }
    }

    // ביטול
    else if (data.intent === "cancel") {
      const snapshot = await db
        .collection("appointments")
        .where("user", "==", user)
        .get();

      if (snapshot.empty) {
        reply = "אין לך תור לבטל 😅";
      } else {
        for (const doc of snapshot.docs) {
          await doc.ref.delete();
        }
        reply = "התור בוטל 👍";
      }
    }

    else {
      reply = "לא הבנתי 😅 אפשר לכתוב: אני רוצה תור ב16:00";
    }
  } catch (err) {
    console.error("❌ MAIN ERROR:", err);
    reply = "שגיאה זמנית 😔 נסה שוב";
  }

  // ================= חשוב ביותר =================
  const twiml = new MessagingResponse();
  twiml.message(reply);

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

// ================= REMINDERS =================
app.get("/run-reminders", async (req, res) => {
  try {
    const now = new Date();
    const snapshot = await db.collection("appointments").get();

    for (const doc of snapshot.docs) {
      const data = doc.data();

      const appt = new Date(`${data.date}T${data.time}`);
      const diffMin = (appt - now) / 60000;

      if (diffMin < 1440 && diffMin > 0 && !data.reminder1) {
        console.log("📅 24h reminder", data.user);
        await doc.ref.update({ reminder1: true });
      }

      if (diffMin < 60 && diffMin > 0 && !data.reminder2) {
        console.log("⏰ 1h reminder", data.user);
        await doc.ref.update({ reminder2: true });
      }
    }

    res.send("OK");
  } catch (err) {
    console.error("REMINDER ERROR:", err);
    res.status(500).send("error");
  }
});

// ================= START =================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
