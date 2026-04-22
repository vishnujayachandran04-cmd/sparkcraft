// SparkCraft Welding — Backend Server
// Stack: Express · Airtable (persistent DB) · nodemailer

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const path       = require("path");
const fs         = require("fs");
const rateLimit  = require("express-rate-limit");
const nodemailer = require("nodemailer");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Airtable ──────────────────────────────────────────────────────────────────
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE  = process.env.AIRTABLE_BASE;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || "Quotes";
const AT_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`;

const atHeaders = {
  "Authorization": `Bearer ${AIRTABLE_TOKEN}`,
  "Content-Type": "application/json"
};

async function atFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...atHeaders, ...(options.headers||{}) } });
  return res.json();
}

async function getAllQuotes() {
  let records = [];
  let offset = null;
  do {
    const url = AT_URL + (offset ? `?offset=${offset}` : '');
    const data = await atFetch(url);
    if (data.records) records = records.concat(data.records);
    offset = data.offset || null;
  } while (offset);
  return records
    .map(r => ({ id: r.id, ...r.fields }))
    .sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
}

async function getQuotesByStatus(status) {
  const url = `${AT_URL}?filterByFormula={status}="${status}"`;
  const data = await atFetch(url);
  return (data.records||[]).map(r=>({id:r.id,...r.fields})).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at));
}

async function getQuoteById(id) {
  const data = await atFetch(`${AT_URL}/${id}`);
  if (data.id) return { id: data.id, ...data.fields };
  return null;
}

async function insertQuote(fields) {
  const data = await atFetch(AT_URL, {
    method: "POST",
    body: JSON.stringify({ fields: { ...fields, status: "new", created_at: new Date().toISOString() } })
  });
  return { id: data.id, ...data.fields };
}

async function updateQuoteStatus(id, status) {
  await atFetch(`${AT_URL}/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ fields: { status } })
  });
}

async function deleteQuoteById(id) {
  await atFetch(`${AT_URL}/${id}`, { method: "DELETE" });
}

async function getStats() {
  const q = await getAllQuotes();
  return {
    total: q.length,
    new_count:       q.filter(x=>x.status==="new").length,
    reviewed_count:  q.filter(x=>x.status==="reviewed").length,
    contacted_count: q.filter(x=>x.status==="contacted").length,
    completed_count: q.filter(x=>x.status==="completed").length
  };
}

// ── Gallery DB (JSON file — for images) ───────────────────────────────────────
const GALLERY_FILE = path.join(__dirname, "gallery.json");
function readGallery() {
  if (!fs.existsSync(GALLERY_FILE)) fs.writeFileSync(GALLERY_FILE, JSON.stringify({ images:[], nextId:1 }, null, 2));
  return JSON.parse(fs.readFileSync(GALLERY_FILE, "utf8"));
}
function writeGallery(data) { fs.writeFileSync(GALLERY_FILE, JSON.stringify(data, null, 2)); }
function getAllImages() { return readGallery().images.sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)); }
function insertImage(data) {
  const db = readGallery();
  const img = { id:db.nextId++, ...data, created_at:new Date().toISOString() };
  db.images.push(img); writeGallery(db); return img;
}
function deleteImageById(id) {
  const db = readGallery();
  db.images = db.images.filter(i=>i.id!==parseInt(id)); writeGallery(db);
}

// ── Email ─────────────────────────────────────────────────────────────────────
let transporter = null;
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({ host:process.env.SMTP_HOST||"smtp.gmail.com", port:parseInt(process.env.SMTP_PORT||"587"), secure:process.env.SMTP_SECURE==="true", auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS} });
  console.log("✉️  Email notifications enabled");
} else { console.log("📭  Email disabled"); }

async function sendNotificationEmail(quote) {
  if (!transporter) return;
  try { await transporter.sendMail({ from:`"SparkCraft Website" <${process.env.FROM_EMAIL}>`, to:process.env.NOTIFY_EMAIL, subject:`New quote from ${quote.first_name} ${quote.last_name}`, html:`<h2 style="color:#2563EB;">New Quote — SparkCraft</h2><p><b>Name:</b> ${quote.first_name} ${quote.last_name}<br><b>Email:</b> ${quote.email}<br><b>Phone:</b> ${quote.phone||"—"}<br><b>Service:</b> ${quote.service}<br><b>Message:</b> ${quote.message||"—"}</p>` }); }
  catch(err) { console.error("Owner email failed:", err.message); }
}
async function sendConfirmationEmail(quote) {
  if (!transporter) return;
  try { await transporter.sendMail({ from:`"SparkCraft Welding" <${process.env.FROM_EMAIL}>`, to:quote.email, subject:`We received your quote request, ${quote.first_name}!`, html:`<div style="font-family:sans-serif"><h2>Thanks, ${quote.first_name}!</h2><p>We received your <b>${quote.service}</b> request and will be in touch within 1 business day.</p></div>` }); }
  catch(err) { console.error("Confirmation email failed:", err.message); }
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(",").map(o=>o.trim()) : "*" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const quoteLimiter = rateLimit({ windowMs:15*60*1000, max:5, message:{error:"Too many requests."} });
const adminLimiter = rateLimit({ windowMs:15*60*1000, max:100, message:{error:"Too many requests."} });

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

// ── Public Routes ─────────────────────────────────────────────────────────────
app.post("/api/quote", quoteLimiter, async (req,res) => {
  const errors = validateQuote(req.body);
  if (errors.length) return res.status(422).json({error:errors.join(" ")});
  try {
    const {first_name,last_name,email,phone,service,message} = req.body;
    const quote = await insertQuote({ first_name:first_name.trim(), last_name:last_name.trim(), email:email.trim().toLowerCase(), phone:phone?phone.trim():"", service:service.trim(), message:message?message.trim():"" });
    sendNotificationEmail(quote);
    sendConfirmationEmail(quote);
    res.status(201).json({ success:true, message:"Quote received! We'll be in touch within 1 business day.", id:quote.id });
  } catch(err) { console.error(err); res.status(500).json({error:"Something went wrong."}); }
});

app.get("/api/gallery", (req,res) => res.json(getAllImages()));

// ── Admin Routes ──────────────────────────────────────────────────────────────
app.get("/api/admin/quotes", adminLimiter, requireAdmin, async (req,res) => {
  try {
    const quotes = req.query.status ? await getQuotesByStatus(req.query.status) : await getAllQuotes();
    res.json(quotes);
  } catch(err) { console.error(err); res.status(500).json({error:"Failed to fetch quotes"}); }
});

app.get("/api/admin/stats", adminLimiter, requireAdmin, async (req,res) => {
  try { res.json(await getStats()); }
  catch(err) { res.status(500).json({error:"Failed to fetch stats"}); }
});

app.get("/api/admin/quotes/:id", adminLimiter, requireAdmin, async (req,res) => {
  try {
    const q = await getQuoteById(req.params.id);
    q ? res.json(q) : res.status(404).json({error:"Not found"});
  } catch(err) { res.status(500).json({error:"Failed"}); }
});

app.patch("/api/admin/quotes/:id", adminLimiter, requireAdmin, async (req,res) => {
  const allowed=["new","reviewed","contacted","completed"];
  if (!allowed.includes(req.body.status)) return res.status(422).json({error:`Status must be: ${allowed.join(", ")}`});
  try { await updateQuoteStatus(req.params.id, req.body.status); res.json({success:true}); }
  catch(err) { res.status(500).json({error:"Failed"}); }
});

app.delete("/api/admin/quotes/:id", adminLimiter, requireAdmin, async (req,res) => {
  try { await deleteQuoteById(req.params.id); res.json({success:true}); }
  catch(err) { res.status(500).json({error:"Failed"}); }
});

// Gallery admin
app.get("/api/admin/gallery", adminLimiter, requireAdmin, (req,res) => res.json(getAllImages()));
app.post("/api/admin/gallery", adminLimiter, requireAdmin, (req,res) => {
  const { data, caption } = req.body;
  if (!data) return res.status(422).json({ error:"Image data required." });
  if (data.length > 8*1024*1024) return res.status(422).json({ error:"Image too large." });
  try { const img = insertImage({ data, caption:caption||"" }); res.status(201).json({ success:true, id:img.id }); }
  catch(err) { res.status(500).json({ error:"Upload failed." }); }
});
app.delete("/api/admin/gallery/:id", adminLimiter, requireAdmin, (req,res) => {
  deleteImageById(req.params.id); res.json({ success:true });
});

app.get("*", (req,res) => res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT, () => {
  console.log(`\n🔥  SparkCraft server → http://localhost:${PORT}`);
  console.log(`📋  Admin panel       → http://localhost:${PORT}/admin.html`);
  console.log(`💾  Quotes stored in  → Airtable`);
  console.log(`🖼️   Gallery stored in → gallery.json\n`);
});
