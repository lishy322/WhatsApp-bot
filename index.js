require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const admin = require("firebase-admin");
const twilio = require("twilio");
const path = require("path");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ===== Firebase =====
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY))
});
const db = admin.firestore();

// ===== Twilio =====
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ===== הגדרות =====
const services = {
  "גבר": 15,
  "ילד": 20,
  "אישה": 40
};

const workers = ["דוד", "משה"];
const sessions = {};

// ===== helpers =====
function send(to, msg) {
  return client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body: msg
  });
}

function getNextDay(day) {
  const map = {
    "ראשון":0,"שני":1,"שלישי":2,
    "רביעי":3,"חמישי":4,"שישי":5,"שבת":6
  };

  const now = new Date();
  let diff = map[day] - now.getDay();
  if (diff <= 0) diff += 7;

  const d = new Date();
  d.setDate(now.getDate() + diff);

  return d.toISOString().split("T")[0];
}

// ===== בדיקת חפיפות =====
async function isAvailable(date, time, duration, worker) {
  const snap = await db.collection("appointments")
    .where("date","==",date)
    .where("worker","==",worker)
    .get();

  const [h,m] = time.split(":").map(Number);
  const start = h*60 + m;
  const end = start + duration;

  for (const doc of snap.docs) {
    const a = doc.data();
    const dur = services[a.type] || 15;

    const [hh,mm] = a.time.split(":").map(Number);
    const s = hh*60 + mm;
    const e = s + dur;

    if (start < e && end > s) return false;
  }

  return true;
}

// ===== BOT =====
app.post("/whatsapp", async (req,res)=>{
  const msg = req.body.Body.trim();
  const from = req.body.From;

  if (!sessions[from]) sessions[from] = {};
  const s = sessions[from];

  try {

    if (!s.step) {
      s.step = "start";
      await send(from,"היי 👋 רוצה לקבוע תור?");
      return res.send("ok");
    }

    if (s.step==="start") {
      s.step="worker";
      await send(from,"לאיזה ספר?\n👉 דוד / משה");
      return res.send("ok");
    }

    if (s.step==="worker") {
      if (workers.includes(msg)) {
        s.worker = msg;
        s.step = "type";
        await send(from,"למי התור?\n👉 גבר / אישה / ילד");
      }
      return res.send("ok");
    }

    if (s.step==="type") {
      if (services[msg]) {
        s.type = msg;
        s.step = "date";
        await send(from,"לאיזה יום?\n👉 מחר / יום רביעי");
      }
      return res.send("ok");
    }

    if (s.step==="date") {

      let date=null;

      if (msg.includes("מחר")) {
        const d=new Date();
        d.setDate(d.getDate()+1);
        date=d.toISOString().split("T")[0];
      } else {
        const match=msg.match(/יום\s(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
        if (match) date=getNextDay(match[1]);
      }

      if (!date) {
        await send(from,"לא הבנתי תאריך 😅");
        return res.send("ok");
      }

      s.date = date;
      s.step = "time";

      await send(from,`איזה שעה ל-${date}?`);
      return res.send("ok");
    }

    if (s.step==="time") {

      let time = msg.length<=2 ? msg+":00" : msg;

      const ok = await isAvailable(
        s.date,
        time,
        services[s.type],
        s.worker
      );

      if (!ok) {
        await send(from,"השעה תפוסה 😅 נסה אחרת");
        return res.send("ok");
      }

      await db.collection("appointments").add({
        user:from,
        date:s.date,
        time,
        type:s.type,
        worker:s.worker
      });

      await send(from,`🎉 נקבע תור ל-${s.date} ${time}`);
      sessions[from]={};

      return res.send("ok");
    }

  } catch(e) {
    console.error(e);
  }

  res.send("ok");
});

// ===== API =====
app.get("/appointments/week", async (req,res)=>{
  const snap = await db.collection("appointments").get();
  const result = [];

  snap.docs.forEach(doc=>{
    const a = doc.data();
    const dur = services[a.type] || 15;

    const [h,m] = a.time.split(":").map(Number);
    const blocks = Math.ceil(dur/15);

    for (let i=0;i<blocks;i++) {
      let mm = m + i*15;
      let hh = h;

      if (mm>=60){
        hh += Math.floor(mm/60);
        mm = mm%60;
      }

      result.push({
        id:doc.id,
        date:a.date,
        time:String(hh).padStart(2,"0")+":"+String(mm).padStart(2,"0"),
        type:a.type,
        worker:a.worker
      });
    }
  });

  res.json(result);
});

// ביטול
app.delete("/appointments/:id", async (req,res)=>{
  await db.collection("appointments").doc(req.params.id).delete();
  res.send("ok");
});

// שינוי
app.put("/appointments/:id", async (req,res)=>{
  await db.collection("appointments").doc(req.params.id).update(req.body);
  res.send("ok");
});

// ===== ROOT =====
app.get("/", (req,res)=>{
  res.sendFile(path.join(__dirname,"public","index.html"));
});

app.listen(8080,()=>console.log("🚀 FULL SYSTEM READY"));
