const express = require("express");
const twilio = require("twilio");
const OpenAI = require("openai");

const app = express();
app.use(express.urlencoded({ extended: false }));

// ===== TWILIO =====
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ===== OPENAI =====
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== זיכרון פשוט (במקום Firebase) =====
const sessions = {};

// ===== שעות זמינות =====
const availableSlots = ["16:00", "17:00", "18:00"];

// ===== WEBHOOK =====
app.post("/webhook", async (req, res) => {
  const incomingMsg = req.body.Body?.trim();
  const from = req.body.From;

  let reply = "";

  try {
    // יצירת session אם אין
    if (!sessions[from]) {
      sessions[from] = { step: "start" };
    }

    const userSession = sessions[from];

    // ===== לוגיקה חכמה =====

    // שלב 1 - התחלה
    if (userSession.step === "start") {
      reply = "שלום! 👋 איך אפשר לעזור?";
      userSession.step = "waiting";
    }

    // שלב 2 - הבנת כוונה
    else if (userSession.step === "waiting") {
      // אם רוצה לקבוע תור
      if (
        incomingMsg.includes("תור") ||
        incomingMsg.includes("לקבוע") ||
        incomingMsg.includes("פגישה")
      ) {
        reply = `מעולה 🙌\nיש לי שעות פנויות:\n${availableSlots.join(
          ", "
        )}\nאיזה שעה מתאימה לך?`;
        userSession.step = "choosing_time";
      } else {
        // 🤖 AI fallback
        const aiResponse = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: "ענה בעברית קצר וברור.",
            },
            {
              role: "user",
              content: incomingMsg,
            },
          ],
        });

        reply = aiResponse.choices[0].message.content;
      }
    }

    // שלב 3 - בחירת שעה
    else if (userSession.step === "choosing_time") {
     const selected = availableSlots.find((slot) => {
  const short = slot.split(":")[0]; // 16 מתוך 16:00
  return incomingMsg.includes(slot) || incomingMsg === short;
});

      if (selected) {
        reply = `מעולה! 🎉 קבעתי לך תור ל-${selected} ✅`;
        userSession.step = "done";
      } else {
        reply = `לא זיהיתי שעה 😅\nבחר אחת מהאפשרויות:\n${availableSlots.join(
          ", "
        )}`;
      }
    }

    // שלב 4 - סיום
    else {
      reply = "צריך עוד משהו? 😊";
      userSession.step = "waiting";
    }
  } catch (err) {
    console.error(err);
    reply = "קרתה שגיאה 😢 נסה שוב";
  }

  // ===== שליחה לוואטסאפ =====
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Message>${reply}</Message>
    </Response>
  `);
});

// ===== SERVER =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});
