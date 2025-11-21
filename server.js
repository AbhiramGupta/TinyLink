import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { customAlphabet } from "nanoid";
import bodyParser from "body-parser";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Client } = pg;

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


app.get("/", async (req, res) => {
  try {
    const result = await db.query(
      "SELECT code, target_url, total_clicks, last_clicked FROM links WHERE deleted = false ORDER BY created_at DESC"
    );
    const links = result.rows;

    res.render("index", { links, baseUrl: BASE_URL });

  } catch (err) {
    console.log(err);
    res.status(500).send("Server error");
  }
});


app.post("/shorten", async (req, res) => {
  const { FullUrl, customCode } = req.body;

  if (!FullUrl) {
    return res.status(400).send("URL required");
  }

  let normalized = FullUrl;
  try {
    const u = new URL(FullUrl);
    normalized = u.toString();
  } catch (e) {
    try {
      normalized = new URL("https://" + FullUrl).toString();
    } catch (_) {
      return res.status(400).send("Invalid URL");
    }
  }

  let code = customCode && customCode.trim() ? customCode.trim() : null;

  if (code) {
    const exists = await db.query("SELECT 1 FROM links WHERE code = $1", [code]);
    if (exists.rowCount > 0) {
      return res.status(409).send("Custom code already exists");
    }
    if (!/^[A-Za-z0-9]{3,8}$/.test(code)) {
      return res.status(400).send("Code must be 3-8 letters/digits");
    }
  } else {
    
    for (let i = 0; i < 10; i++) {
      const candidate = nano();
      const exists = await db.query("SELECT 1 FROM links WHERE code = $1", [candidate]);
      if (exists.rowCount === 0) {
        code = candidate;
        break;
      }
    }
  }

  
  await db.query(
    "INSERT INTO links(code, target_url) VALUES ($1, $2)",
    [code, normalized]
  );

  res.redirect("/");
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

  const r = await db.query(query, [code]);

  if (r.rowCount === 0) return res.status(404).send("Not found");

  const target = r.rows[0].target_url;
  res.redirect(target);
});

app.post("/delete/:code", async (req, res) => {
  const { code } = req.params;
  await db.query("UPDATE links SET deleted = true WHERE code = $1", [code]);
  res.redirect("/");
});

app.listen(port, () => {
  console.log(`TinyLink running on ${port} → ${BASE_URL}`);
});
