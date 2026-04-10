const express = require('express');
const admin = require('firebase-admin');
const twilio = require('twilio');
const OpenAI = require('openai');

const app = express();
app.use(express.urlencoded({ extended: false }));

// ================== FIREBASE ==================
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ================== TWILIO ==================
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ================== OPENAI ==================
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ================== זמני תורים ==================
const availableSlots = ["16:00", "17:00", "18:00"];

// ================== זיכרון שיחה ==================
const sessions = {};

// ================== ROUTE ==================
app.post("/webhook", async (req, res) => {
  const incomingMsg = req.body.Body;
  const from = req.body.From;

  let reply = "";

  try {
    // 🤖 שליחת הודעה ל-AI
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
אתה בוט קביעת תורים.
ענה בעברית.
אם מישהו רוצה לקבוע תור:
- הצע שעות: 16:00, 17:00, 18:00
- אם הוא בוחר שעה – אשר את התור

אם לא ברור – שאל שאלה.
          `,
        },
        {
          role: "user",
          content: incomingMsg,
        },
      ],
    });

    reply = aiResponse.choices[0].message.content;

    // 💾 שמירה בפיירבייס (לא חובה אבל טוב)
    await db.collection("messages").add({
      from,
      message: incomingMsg,
      reply,
      createdAt: new Date(),
    });

  } catch (err) {
    console.error("AI ERROR:", err);
    reply = "משהו השתבש, נסה שוב 🙏";
  }

  // 📤 שליחה לוואטסאפ
  res.set("Content-Type", "text/xml");
  res.send(`
    <Response>
      <Message>${reply}</Message>
    </Response>
  `);
});

      const intent = ai.choices[0].message.content;

      if (intent.includes("YES")) {
        session.step = "choose_time";

        reply = `מעולה 👍 רוצה לקבוע תור\n\nיש שעות פנויות:\n${availableSlots.join("\n")}\n\nאיזה שעה נוחה לך?`;
      } else {
        reply = "שלום! 👋 איך אפשר לעזור?";
      }
    }

    // ================== שלב 2 ==================
    else if (session.step === "choose_time") {

      if (availableSlots.includes(incomingMsg)) {

        await db.collection("appointments").add({
          phone: from,
          time: incomingMsg,
          createdAt: new Date(),
        });

        reply = `🎉 התור נקבע ל-${incomingMsg}\nמחכים לך!`;

        session.step = "done";
      } else {
        reply = `לא מצאתי את השעה 🤔\nבחר מתוך:\n${availableSlots.join("\n")}`;
      }
    }

    // ================== סיום ==================
    else {
      session.step = "start";
      reply = "אפשר לקבוע תור נוסף 👍";
    }

  } catch (err) {
    console.error(err);
    reply = "אירעה שגיאה 😅 נסה שוב";
  }

  res.send(`
    <Response>
      <Message>${reply}</Message>
    </Response>
  `);
});

// ================== SERVER ==================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
