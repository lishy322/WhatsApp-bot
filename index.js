const express = require("express");
const admin = require("firebase-admin");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();
app.use(express.urlencoded({ extended: false }));

// ===== בדיקת שרת =====
app.get("/", (req, res) => {
  res.send("Server is alive");
});

// ===== Firebase (עם הגנה מקריסה) =====
let db = null;

try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  db = admin.firestore();
  console.log("✅ Firebase connected");

} catch (err) {
  console.log("❌ Firebase not connected - working without DB");
}

// ===== OpenAI =====
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== Twilio =====
const MessagingResponse = twilio.twiml.MessagingResponse;

// ===== שעות זמינות =====
const availableSlots = ["16:00", "17:00", "18:00"];

// ===== Webhook =====
app.post("/webhook", async (req, res) => {
  const incomingMsg = req.body.Body;
  const today = new Date().toISOString().split("T")[0];
  const user = req.body.From;

  console.log("📩 Incoming:", incomingMsg);

  let reply = "";

  try {
    // ===== AI =====
    const ai = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: `
תחזיר רק JSON:
{
 "intent": "book | greeting | other",
 "time": "HH:MM או null"
}
`
        },
        {
          role: "user",
          content: incomingMsg
        }
      ]
    });

    let data;

try {
  let txt = ai.output[0].content[0].text;

  // ניקוי טקסט
  txt = txt.replace(/```json/g, "").replace(/```/g, "").trim();

  data = JSON.parse(txt);

  // תיקון שעה (18 → 18:00)
  if (data.time && data.time.length === 2) {
    data.time = data.time + ":00";
  }

} catch (err) {
  console.log("AI PARSE ERROR:", err);

  // 👇 fallback חכם במקום קריסה
  const match = incomingMsg.match(/\d{1,2}/);
  if (match) {
    data = {
      intent: "book",
      time: match[0].padStart(2, "0") + ":00"
    };
  } else {
    data = { intent: "other", time: null };
  }
}

    } catch {
      data = { intent: "other", time: null };
    }

    // ===== ברכה =====
    if (data.intent === "greeting") {
      reply = "שלום! 👋 רוצה לקבוע תור?";
    }

    // ===== קביעת תור =====
    else if (data.intent === "book") {

      if (!data.time) {
        reply = `איזה שעה נוחה לך?\n${availableSlots.join(", ")}`;
      }

      else if (!availableSlots.includes(data.time)) {
        reply = `השעה לא זמינה 😅\nבחר:\n${availableSlots.join(", ")}`;
      }

      else {
        // ===== אם אין Firebase =====
        if (!db) {
          reply = `🎉 נקבע תור ל-${data.time} (לא נשמר במערכת)`;
        }

        else {
          await db.collection("appointments").add({
          user,
          time: data.time,
          date: today,
          createdAt: new Date()
          });

          if (!snapshot.empty) {
            reply = `התור תפוס 😞\nבחר שעה אחרת:\n${availableSlots.join(", ")}`;
          } else {
            await db.collection("appointments").add({
              user,
              time: data.time,
              createdAt: new Date()
            });

            reply = `🎉 התור נקבע ל-${data.time}`;
          }
        }
      }
    }

    // ===== ברירת מחדל =====
    else {
      reply = "אפשר לכתוב: אני רוצה תור ב16:00";
    }

  } catch (err) {
    console.error("🔥 ERROR:", err);
    reply = "שגיאה זמנית 😔 נסה שוב";
  }

  const twiml = new MessagingResponse();
  twiml.message(reply);

  res.writeHead(200, { "Content-Type": "text/xml" });
  res.end(twiml.toString());
});

// ===== הפעלת שרת =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
