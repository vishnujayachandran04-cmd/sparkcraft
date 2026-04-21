// SparkCraft Welding — Backend Server
// Stack: Express · JSON file DB (no compilation needed) · nodemailer

require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const path      = require("path");
const fs        = require("fs");
const rateLimit = require("express-rate-limit");
const nodemailer = require("nodemailer");

const app  = express();
const PORT = process.env.PORT || 3000;

// JSON File Database — stores all quotes in quotes.json, no Python needed
const DB_FILE = path.join(__dirname, "quotes.json");

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ quotes: [], nextId: 1 }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
function getAllQuotes() { return readDB().quotes.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)); }
function getQuotesByStatus(status) { return getAllQuotes().filter(q=>q.status===status); }
function getQuoteById(id) { return readDB().quotes.find(q=>q.id===parseInt(id)); }

function insertQuote(data) {
  const db = readDB();
  const quote = { id: db.nextId++, ...data, status: "new", created_at: new Date().toISOString() };
  db.quotes.push(quote);
  writeDB(db);
  return quote;
}
function updateQuoteStatus(id, status) {
  const db = readDB();
  const q = db.quotes.find(q=>q.id===parseInt(id));
  if (q) q.status = status;
  writeDB(db);
}
function deleteQuoteById(id) {
  const db = readDB();
  db.quotes = db.quotes.filter(q=>q.id!==parseInt(id));
  writeDB(db);
}
function getStats() {
  const q = getAllQuotes();
  return { total:q.length, new_count:q.filter(x=>x.status==="new").length, reviewed_count:q.filter(x=>x.status==="reviewed").length, contacted_count:q.filter(x=>x.status==="contacted").length, completed_count:q.filter(x=>x.status==="completed").length };
}

// Email
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({ host:process.env.SMTP_HOST||"smtp.gmail.com", port:parseInt(process.env.SMTP_PORT||"587"), secure:process.env.SMTP_SECURE==="true", auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS} });
  console.log("✉️  Email notifications enabled");
} else { console.log("📭  Email disabled — set SMTP_USER & SMTP_PASS in .env to enable"); }

async function sendNotificationEmail(quote) {
  if (!transporter) return;
  try { await transporter.sendMail({ from:`"SparkCraft Website" <${process.env.FROM_EMAIL}>`, to:process.env.NOTIFY_EMAIL, subject:`New quote from ${quote.first_name} ${quote.last_name}`, html:`<h2 style="color:#F97316;">New Quote — SparkCraft</h2><p><b>Name:</b> ${quote.first_name} ${quote.last_name}<br><b>Email:</b> ${quote.email}<br><b>Phone:</b> ${quote.phone||"—"}<br><b>Service:</b> ${quote.service}<br><b>Message:</b> ${quote.message||"—"}</p>` }); }
  catch(err) { console.error("Owner email failed:", err.message); }
}
async function sendConfirmationEmail(quote) {
  if (!transporter) return;
  try { await transporter.sendMail({ from:`"SparkCraft Welding" <${process.env.FROM_EMAIL}>`, to:quote.email, subject:`We received your quote request, ${quote.first_name}!`, html:`<div style="font-family:sans-serif"><h2>Thanks, ${quote.first_name}!</h2><p>We received your <b>${quote.service}</b> request and will be in touch within 1 business day.</p><p>Questions? Call <b>(555) 123-4567</b>.</p></div>` }); }
  catch(err) { console.error("Confirmation email failed:", err.message); }
}

// Middleware
app.use(cors({ origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map(o=>o.trim()) : "*" }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const quoteLimiter = rateLimit({ windowMs:15*60*1000, max:5, message:{error:"Too many requests."} });
const adminLimiter = rateLimit({ windowMs:15*60*1000, max:60, message:{error:"Too many requests."} });

function requireAdmin(req,res,next) {
  if (req.headers["x-admin-password"]!==process.env.ADMIN_PASSWORD) return res.status(401).json({error:"Unauthorized"});
  next();
}
function validateQuote(b) {
  const e=[];
  if (!b.first_name||!b.first_name.trim()) e.push("First name required.");
  if (!b.last_name||!b.last_name.trim()) e.push("Last name required.");
  if (!b.email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) e.push("Valid email required.");
  if (!b.service||!b.service.trim()) e.push("Service required.");
  return e;
}

// Public
app.post("/api/quote", quoteLimiter, async (req,res) => {
  const errors = validateQuote(req.body);
  if (errors.length) return res.status(422).json({error:errors.join(" ")});
  try {
    const {first_name,last_name,email,phone,service,message} = req.body;
    const quote = insertQuote({ first_name:first_name.trim(), last_name:last_name.trim(), email:email.trim().toLowerCase(), phone:phone?phone.trim():null, service:service.trim(), message:message?message.trim():null });
    sendNotificationEmail(quote);
    sendConfirmationEmail(quote);
    res.status(201).json({ success:true, message:"Quote received! We'll be in touch within 1 business day.", id:quote.id });
  } catch(err) { console.error(err); res.status(500).json({error:"Something went wrong."}); }
});

// Admin
app.get("/api/admin/quotes",   adminLimiter, requireAdmin, (req,res) => res.json(req.query.status ? getQuotesByStatus(req.query.status) : getAllQuotes()));
app.get("/api/admin/stats",    adminLimiter, requireAdmin, (req,res) => res.json(getStats()));
app.get("/api/admin/quotes/:id", adminLimiter, requireAdmin, (req,res) => { const q=getQuoteById(req.params.id); q ? res.json(q) : res.status(404).json({error:"Not found"}); });
app.patch("/api/admin/quotes/:id", adminLimiter, requireAdmin, (req,res) => {
  const allowed=["new","reviewed","contacted","completed"];
  if (!allowed.includes(req.body.status)) return res.status(422).json({error:`Status must be: ${allowed.join(", ")}`});
  if (!getQuoteById(req.params.id)) return res.status(404).json({error:"Not found"});
  updateQuoteStatus(req.params.id, req.body.status);
  res.json({success:true});
});
app.delete("/api/admin/quotes/:id", adminLimiter, requireAdmin, (req,res) => {
  if (!getQuoteById(req.params.id)) return res.status(404).json({error:"Not found"});
  deleteQuoteById(req.params.id);
  res.json({success:true});
});
app.get("*", (req,res) => res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT, () => {
  console.log(`\n🔥  SparkCraft server → http://localhost:${PORT}`);
  console.log(`📋  Admin panel       → http://localhost:${PORT}/admin.html`);
  console.log(`💾  Data stored in    → quotes.json\n`);
});
