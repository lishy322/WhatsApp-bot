require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const admin = require("firebase-admin");
const twilio = require("twilio");
const OpenAI = require("openai");
const path = require("path");

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use(session({
  secret: "secret123",
  resave: false,
  saveUninitialized: true
}));

app.use(express.static("public"));

/* ================= FIREBASE ================= */
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY))
});
const db = admin.firestore();

/* ================= TWILIO ================= */
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/* ================= OPENAI ================= */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* ================= CONFIG ================= */

const services = {
  "גבר": 15,
  "ילד": 20,
  "אישה": 40
};

const workers = ["דוד","משה"];

const workerConfig = {
  "דוד": { start:"08:00", end:"18:00", breaks:["13:00"], daysOff:["שישי"] },
  "משה": { start:"09:00", end:"17:00", breaks:["12:00"], daysOff:["שישי"] }
};

const sessions = {};

/* ================= AUTH ================= */

function requireAuth(req,res,next){
  if(!req.session.loggedIn) return res.redirect("/login");
  next();
}

app.get("/", (req,res)=>res.redirect("/login"));

app.get("/login",(req,res)=>{
  res.sendFile(path.join(__dirname,"public","login.html"));
});

app.post("/login",(req,res)=>{
  if(req.body.password === process.env.ADMIN_PASSWORD){
    req.session.loggedIn = true;
    return res.redirect("/admin");
  }
  res.send("סיסמה שגויה");
});

app.get("/admin", requireAuth, (req,res)=>{
  res.sendFile(path.join(__dirname,"public","index.html"));
});

/* ================= HELPERS ================= */

async function send(to,msg){
  return client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: to,
    body: msg
  });
}

function getNextDay(day){
  const map={"ראשון":0,"שני":1,"שלישי":2,"רביעי":3,"חמישי":4,"שישי":5,"שבת":6};
  const now=new Date();
  let diff=map[day]-now.getDay();
  if(diff<=0) diff+=7;
  const d=new Date();
  d.setDate(now.getDate()+diff);
  return d.toISOString().split("T")[0];
}

/* ================= CRM ================= */

async function getOrCreateCustomer(phone){
  const ref = db.collection("customers").doc(phone);
  const doc = await ref.get();

  if(!doc.exists){
    await ref.set({
      phone,
      visits:0,
      createdAt:new Date()
    });
    return { phone, visits:0 };
  }

  return doc.data();
}

/* ================= AI ================= */

async function parseWithAI(text){
  try{
    const completion = await openai.chat.completions.create({
      model:"gpt-4o-mini",
      messages:[{
        role:"user",
        content:`הוצא יום, שעה וסוג תור מהמשפט:
        ${text}
        תחזיר JSON בלבד`
      }]
    });

    return JSON.parse(completion.choices[0].message.content);
  }catch{
    return {};
  }
}

/* ================= BUSINESS LOGIC ================= */

async function isClosed(date){
  const doc = await db.collection("closedDays").doc(date).get();
  return doc.exists;
}

async function isAvailable(date,time,duration,worker){

  const config = workerConfig[worker];

  const dayName = new Date(date).toLocaleDateString("he-IL",{weekday:"long"});
  if(config.daysOff.includes(dayName)) return false;

  if(time < config.start || time >= config.end) return false;
  if(config.breaks.includes(time)) return false;

  const snap = await db.collection("appointments")
    .where("date","==",date)
    .where("worker","==",worker)
    .get();

  const [h,m] = time.split(":").map(Number);
  const start = h*60+m;
  const end = start + duration;

  for(const doc of snap.docs){
    const a = doc.data();
    const dur = services[a.type] || 15;

    const [hh,mm] = a.time.split(":").map(Number);
    const s = hh*60+mm;
    const e = s+dur;

    if(start < e && end > s) return false;
  }

  return true;
}

/* ================= WHATSAPP ================= */

app.post("/whatsapp", async (req,res)=>{

  const msg = req.body.Body.trim();
  const from = req.body.From;

  if(!sessions[from]) sessions[from]={};
  const s = sessions[from];

  try{

    const customer = await getOrCreateCustomer(from);

    if(!s.started){
      s.started = true;

      if(customer.visits>0){
        await send(from,`ברוך שובך 👋 (${customer.visits} ביקורים)`);
      } else {
        await send(from,"היי 👋 רוצה לקבוע תור?");
      }

      return res.send("ok");
    }

    // ===== FIX LOOP =====
    if(["דוד","משה"].includes(msg)) s.worker = msg;
    if(["גבר","אישה","ילד"].includes(msg)) s.type = msg;

    if(/^\d{1,2}$/.test(msg)) s.time = msg.padStart(2,"0")+":00";
    if(/^\d{1,2}:\d{2}$/.test(msg)) s.time = msg;

    const days = ["ראשון","שני","שלישי","רביעי","חמישי","שישי","שבת"];
    if(days.includes(msg)) s.date = getNextDay(msg);

    // AI
    const ai = await parseWithAI(msg);
    if(ai.type) s.type = ai.type;
    if(ai.time) s.time = ai.time;
    if(ai.day) s.date = getNextDay(ai.day);

    if(!s.worker){
      await send(from,"לאיזה ספר?\n👉 דוד / משה");
      return res.send("ok");
    }

    if(!s.type){
      await send(from,"למי התור?\n👉 גבר / אישה / ילד");
      return res.send("ok");
    }

    if(!s.date){
      await send(from,"לאיזה יום?");
      return res.send("ok");
    }

    if(!s.time){
      await send(from,"איזה שעה?");
      return res.send("ok");
    }

    if(await isClosed(s.date)){
      await send(from,"❌ העסק סגור ביום הזה");
      return res.send("ok");
    }

    const ok = await isAvailable(s.date,s.time,services[s.type],s.worker);

    if(!ok){
      await send(from,"השעה תפוסה 😅");
      return res.send("ok");
    }

    await db.collection("appointments").add({
      user:from,
      date:s.date,
      time:s.time,
      type:s.type,
      worker:s.worker
    });

    await db.collection("customers").doc(from).update({
      visits: admin.firestore.FieldValue.increment(1),
      lastVisit:new Date()
    });

    await send(from,`🎉 נקבע תור ל-${s.date} בשעה ${s.time}`);

    sessions[from]={};

  }catch(e){
    console.error(e);
  }

  res.send("ok");
});

/* ================= API ================= */

app.get("/appointments/week", requireAuth, async (req,res)=>{
  const snap = await db.collection("appointments").get();
  res.json(snap.docs.map(d=>({id:d.id,...d.data()})));
});
app.post("/appointments/move", (req, res) => {
  const { id, newDate, newTime } = req.body;

  const appt = appointments.find(a => a.id == id);

  if (!appt) {
    return res.status(404).send("לא נמצא תור");
  }

  // ❗ מניעת חפיפה
  const exists = appointments.find(a =>
    a.date === newDate &&
    a.time === newTime &&
    a.worker === appt.worker
  );

  if (exists) {
    return res.status(400).send("השעה תפוסה");
  }

  // עדכון
  appt.date = newDate;
  appt.time = newTime;

  res.send({ success: true });
});

app.listen(8080,()=>console.log("🚀 FULL SYSTEM READY"));
