
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { customAlphabet } from "nanoid";
import bodyParser from "body-parser";
import pg from "pg";
import dotenv from "dotenv";
import dns from "dns";

dotenv.config();

const { Client } = pg;
const dnsLookup = dns.promises.lookup;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 5000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${port}`;

const db = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

db.connect()
  .then(() => console.log("Postgres connected"))
  .catch(err => console.log("DB Error:", err));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const nano = customAlphabet("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", 6);

async function fetchLinks() {
  const r = await db.query(
    "SELECT code, target_url, total_clicks, last_clicked FROM links WHERE deleted = false ORDER BY created_at DESC"
  );
  return r.rows;
}

async function isValidUrlResolved(urlString) {
  try {
    const url = new URL(urlString);

    if (!["http:", "https:"].includes(url.protocol)) return false;

    const hostname = url.hostname;

    if (!hostname || !hostname.includes(".")) return false;
    if (hostname.endsWith(".")) return false;
    if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) return false;
    const labels = hostname.split(".");
    for (const lab of labels) {
      if (!lab.length) return false;
      if (lab.startsWith("-") || lab.endsWith("-")) return false;
    }

    try {
      await dnsLookup(hostname);
      return true;
    } catch (dnsErr) {
      return false;
    }
  } catch (e) {
    return false;
  }
}

app.get("/", async (req, res) => {
  try {
    const links = await fetchLinks();
    return res.render("index", { links, baseUrl: BASE_URL, error: null });
  } catch (err) {
    console.error("GET / error:", err);
    return res.status(500).send("Server error");
  }
});

app.post("/shorten", async (req, res) => {
  const { FullUrl, customCode } = req.body;

  if (!FullUrl) {
    const links = await fetchLinks();
    return res.render("index", { links, baseUrl: BASE_URL, error: "Please provide a URL." });
  }

  let normalized = FullUrl.trim();
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
    normalized = "https://" + normalized;
  }

  const ok = await isValidUrlResolved(normalized);
  if (!ok) {
    const links = await fetchLinks();
    return res.render("index", { links, baseUrl: BASE_URL, error: "Invalid or non-resolving URL. Please enter a valid domain (e.g. example.com)." });
  }

  let code = customCode && customCode.trim() ? customCode.trim() : null;

  if (code) {
    if (!/^[A-Za-z0-9]{3,8}$/.test(code)) {
      const links = await fetchLinks();
      return res.render("index", { links, baseUrl: BASE_URL, error: "Custom code must be 3-8 alphanumeric characters" });
    }
    try {
      const exists = await db.query("SELECT 1 FROM links WHERE code = $1", [code]);
      if (exists.rowCount > 0) {
        const links = await fetchLinks();
        return res.render("index", { links, baseUrl: BASE_URL, error: "Custom code already exists" });
      }
    } catch (err) {
      console.error("DB error checking custom code:", err);
      const links = await fetchLinks();
      return res.render("index", { links, baseUrl: BASE_URL, error: "Server error checking custom code" });
    }
  } else {
    for (let i = 0; i < 10; i++) {
      const candidate = nano();
      try {
        const exists = await db.query("SELECT 1 FROM links WHERE code = $1", [candidate]);
        if (exists.rowCount === 0) {
          code = candidate;
          break;
        }
      } catch (err) {
        console.error("DB error while checking candidate code:", err);
      }
    }
    if (!code) {
      code = nano() + Math.floor(Math.random() * 1000);
    }
  }

  try {
    await db.query("INSERT INTO links(code, target_url) VALUES ($1, $2)", [code, normalized]);
    return res.redirect("/");
  } catch (err) {
    console.error("Insert error:", err);
    if (err && err.code === "23505") {
      const links = await fetchLinks();
      return res.render("index", { links, baseUrl: BASE_URL, error: "Generated code collided — please try again." });
    }
    const links = await fetchLinks();
    return res.render("index", { links, baseUrl: BASE_URL, error: "Server error creating short link" });
  }
});

app.get('/healthz', async (req, res) => {
  const payload = {
    status: 'ok',
    uptime: process.uptime(),
    version: '1.0.0',
    db: 'unknown'
  };

  try {
    await db.query('SELECT 1');
    payload.db = 'ok';
    return res.status(200).json(payload);
  } catch (err) {
    console.error('DB health check failed:', err);
    payload.db = 'down';
    payload.status = 'error';
    return res.status(500).json(payload);
  }
});

app.get("/:code", async (req, res) => {
  const { code } = req.params;

  const query = `
    UPDATE links
    SET total_clicks = total_clicks + 1, last_clicked = now()
    WHERE code = $1 AND deleted = false
    RETURNING target_url
  `;

  try {
    const r = await db.query(query, [code]);
    if (r.rowCount === 0) {
      return res.status(404).send("Not found");
    }
    const target = r.rows[0].target_url;
    return res.redirect(target);
  } catch (err) {
    console.error("Redirect error:", err);
    return res.status(500).send("Server error");
  }
});

app.post("/delete/:code", async (req, res) => {
  const { code } = req.params;
  try {
    await db.query("UPDATE links SET deleted = true WHERE code = $1", [code]);
    return res.redirect("/");
  } catch (err) {
    console.error("Delete error:", err);
    const links = await fetchLinks();
    return res.render("index", { links, baseUrl: BASE_URL, error: "Server error deleting link" });
  }
});

app.listen(port, () => {
  console.log(`TinyLink running on ${port} → ${BASE_URL}`);
});
