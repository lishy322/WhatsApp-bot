require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const session = require("express-session");
const admin = require("firebase-admin");
const twilio = require("twilio");
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

// ===== נתונים =====
const services = { "גבר":15, "ילד":20, "אישה":40 };
const workers = ["דוד","משה"];
const sessions = {};

// ===== LOGIN =====
app.get("/login",(req,res)=>{
  res.sendFile(path.join(__dirname,"public","login.html"));
});

app.post("/login",(req,res)=>{
  const {password} = req.body;

  if(password === process.env.ADMIN_PASSWORD){
    req.session.loggedIn = true;
    return res.redirect("/admin");
  }

  res.send("סיסמה שגויה");
});

app.get("/logout",(req,res)=>{
  req.session.destroy();
  res.redirect("/login");
});

function requireAuth(req,res,next){
  if(!req.session.loggedIn){
    return res.redirect("/login");
  }
  next();
}

// ===== ROOT =====
app.get("/",(req,res)=>{
  res.redirect("/login");
});

// ===== ADMIN =====
app.get("/admin", requireAuth, (req,res)=>{
  res.sendFile(path.join(__dirname,"public","index.html"));
});

// ===== HELPERS =====
async function send(to,msg){
  return client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to: to,
    body: msg
  });
}

function getNextDay(day){
  const map={"ראשון":0,"שני":1,"שלישי":2,"רביעי":3,"חמישי":4};
  const now=new Date();
  let diff=map[day]-now.getDay();
  if(diff<=0) diff+=7;
  const d=new Date();
  d.setDate(now.getDate()+diff);
  return d.toISOString().split("T")[0];
}

// ===== BOT =====
app.post("/whatsapp", async (req,res)=>{

  const msg=req.body.Body.trim();
  const from=req.body.From;

  if(!sessions[from]) sessions[from]={};
  const s=sessions[from];

  if(!s.step){
    s.step="worker";
    await send(from,"לאיזה ספר?\n👉 דוד / משה");
    return res.send("ok");
  }

  if(s.step==="worker"){
    s.worker=msg;
    s.step="type";
    await send(from,"למי התור?\n👉 גבר / אישה / ילד");
    return res.send("ok");
  }

  if(s.step==="type"){
    s.type=msg;
    s.step="date";
    await send(from,"לאיזה יום?\n👉 מחר / יום שלישי");
    return res.send("ok");
  }

  if(s.step==="date"){

    let date=null;

    if(msg.includes("מחר")){
      const d=new Date();
      d.setDate(d.getDate()+1);
      date=d.toISOString().split("T")[0];
    } else {
      const match=msg.match(/יום\s(ראשון|שני|שלישי|רביעי|חמישי)/);
      if(match) date=getNextDay(match[1]);
    }

    if(!date){
      await send(from,"לא הבנתי תאריך 😅");
      return res.send("ok");
    }

    s.date=date;
    s.step="time";

    await send(from,"איזה שעה?");
    return res.send("ok");
  }

  if(s.step==="time"){

    let time = msg.length<=2 ? msg+":00" : msg;

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

});

// ===== API =====
app.get("/appointments/week", requireAuth, async (req,res)=>{
  const snap = await db.collection("appointments").get();

  const result=[];

  snap.docs.forEach(doc=>{
    const a=doc.data();
    const dur=services[a.type] || 15;

    result.push({
      id: doc.id,
      date: a.date,
      time: a.time,
      duration: dur,
      type: a.type,
      worker: a.worker,
      user: a.user
    });
  });

  res.json(result);
});

// ביטול
app.delete("/appointments/:id", requireAuth, async(req,res)=>{
  await db.collection("appointments").doc(req.params.id).delete();
  res.send("ok");
});

// שינוי
app.put("/appointments/:id", requireAuth, async(req,res)=>{
  await db.collection("appointments").doc(req.params.id).update(req.body);
  res.send("ok");
});

// סגירת יום
app.post("/close-day", requireAuth, async(req,res)=>{
  const {date}=req.body;
  await db.collection("closedDays").doc(date).set({closed:true});
  res.send("ok");
});

app.listen(8080,()=>console.log("🚀 SYSTEM WITH LOGIN READY"));
