const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = 8080;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "noisesensor",
  password: process.env.DB_PASSWORD,
  port: 5432,
});

// Test database connection
pool.connect((err) => {
  if (err) {
    console.error("Database connection failed:", err);
  } else {
    console.log("Connected to PostgreSQL database!");
  }
});

// =================== CREATE TABLES ===================

// Measurements table (already exists in your setup)
const createNoiseReadingsTable = `
  CREATE TABLE IF NOT EXISTS public.noise_readings (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) DEFAULT 'ESP32_001',
    dba_instant DECIMAL(5,2) NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

// Devices table (for map + metadata)
const createDevicesTable = `
  CREATE TABLE IF NOT EXISTS public.devices (
    device_id   VARCHAR(50) PRIMARY KEY,
    label       TEXT NOT NULL,
    address     TEXT,
    latitude    DOUBLE PRECISION NOT NULL,
    longitude   DOUBLE PRECISION NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW()
  );
`;

(async () => {
  try {
    await pool.query(createNoiseReadingsTable);
    console.log('Table "noise_readings" is ready');

    await pool.query(createDevicesTable);
    console.log('Table "devices" is ready');
  } catch (e) {
    console.error("Error creating tables:", e);
  }
})();

// =================== HELPERS ===================

function safePreset(preset) {
  const allowed = ["60s", "60m", "24h", "7d", "day"];
  return allowed.includes(preset) ? preset : null;
}

function parseLimit(value, def = 60) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 5000) return def; // safety cap
  return n;
}

// =================== API ENDPOINTS ===================

// POST endpoint for ESP32 -> store measurement
app.post("/api/noise-data", async (req, res) => {
  const { dba_instant, device_id } = req.body;

  if (dba_instant === undefined || dba_instant === null) {
    return res.status(400).json({ error: "dba_instant is required" });
  }

  const deviceName = device_id || "ESP32_001";

  try {
    const result = await pool.query(
      "INSERT INTO public.noise_readings (device_id, dba_instant) VALUES ($1, $2) RETURNING *",
      [deviceName, dba_instant]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error("Error inserting data:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// GET latest reading (optionally filtered by device_id)
app.get("/api/live", async (req, res) => {
  const { device_id } = req.query;

  try {
    let query = `
      SELECT nr.*
      FROM public.noise_readings nr
    `;
    const params = [];

    if (device_id) {
      query += " WHERE nr.device_id = $1";
      params.push(device_id);
    }

    query += " ORDER BY nr.timestamp DESC LIMIT 1";

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.json({ dba_instant: 0 });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching live data:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// GET raw last N readings (oldest -> newest)
app.get("/api/hourly", async (req, res) => {
  const { device_id, limit } = req.query;
  const recordLimit = parseLimit(limit, 60);

  try {
    let query = `
      SELECT *
      FROM public.noise_readings
    `;
    const params = [];

    if (device_id) {
      query += " WHERE device_id = $1";
      params.push(device_id);
    }

    query += ` ORDER BY timestamp DESC LIMIT ${recordLimit}`;

    const result = await pool.query(query, params);

    // Always return oldest -> newest
    res.json(result.rows.reverse());
  } catch (error) {
    console.error("Error fetching raw data:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// =================== DEVICES (NEW for map) ===================

// GET all devices with coordinates (for Leaflet markers)
app.get("/api/devices", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT device_id, label, address, latitude, longitude, created_at
      FROM public.devices
      ORDER BY device_id ASC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching devices:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// GET one device
app.get("/api/devices/:device_id", async (req, res) => {
  const { device_id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT device_id, label, address, latitude, longitude, created_at
      FROM public.devices
      WHERE device_id = $1
      `,
      [device_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Device not found" });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching device:", error);
    res.status(500).json({ error: "Database error" });
  }
});

// =================== PRESET HISTORY ===================
// Presets:
//   preset=60s  -> last 60 raw seconds (60 points) (raw readings)
//   preset=60m  -> last 60 minutes, avg per minute
//   preset=24h  -> last 24 hours, avg per hour
//   preset=7d   -> last 7 days, avg per day
//   preset=day&date=YYYY-MM-DD -> selected day, avg per hour
app.get("/api/history", async (req, res) => {
  const device_id = req.query.device_id || "ESP32_001";
  const preset = safePreset(req.query.preset);
  const date = req.query.date;

  if (!preset) {
    return res.status(400).json({
      error: "Invalid preset. Use preset=60s|60m|24h|7d or preset=day&date=YYYY-MM-DD",
    });
  }

  let query = "";
  const params = [device_id];

  try {
    switch (preset) {
      case "60s":
        // DESC + LIMIT 60, then reverse in JS so chart left->right
        query = `
          SELECT timestamp, dba_instant::float AS dba
          FROM public.noise_readings
          WHERE device_id = $1
          ORDER BY timestamp DESC
          LIMIT 60
        `;
        break;

      case "60m":
        query = `
          SELECT
            date_trunc('minute', timestamp) AS timestamp,
            AVG(dba_instant)::float AS dba
          FROM public.noise_readings
          WHERE device_id = $1
            AND timestamp >= NOW() - INTERVAL '60 minutes'
          GROUP BY 1
          ORDER BY 1 ASC
        `;
        break;

      case "24h":
        query = `
          SELECT
            date_trunc('hour', timestamp) AS timestamp,
            AVG(dba_instant)::float AS dba
          FROM public.noise_readings
          WHERE device_id = $1
            AND timestamp >= NOW() - INTERVAL '24 hours'
          GROUP BY 1
          ORDER BY 1 ASC
        `;
        break;

      case "7d":
        query = `
          SELECT
            date_trunc('day', timestamp) AS timestamp,
            AVG(dba_instant)::float AS dba
          FROM public.noise_readings
          WHERE device_id = $1
            AND timestamp >= NOW() - INTERVAL '7 days'
          GROUP BY 1
          ORDER BY 1 ASC
        `;
        break;

      case "day":
        if (!date) {
          return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
        }
        params.push(date);
        query = `
          SELECT
            date_trunc('hour', timestamp) AS timestamp,
            AVG(dba_instant)::float AS dba
          FROM public.noise_readings
          WHERE device_id = $1
            AND timestamp >= $2::date
            AND timestamp < ($2::date + INTERVAL '1 day')
          GROUP BY 1
          ORDER BY 1 ASC
        `;
        break;
    }

    const result = await pool.query(query, params);

    // Ensure all responses are oldest->newest
    if (preset === "60s") {
      return res.json(result.rows.reverse());
    }
    return res.json(result.rows);
  } catch (err) {
    console.error("History query failed:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// =================== START SERVER ===================
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log("Available endpoints:");
  console.log("  POST /api/noise-data   - ESP32 sends data");
  console.log("  GET  /api/live         - Latest reading (add ?device_id=ESP32_001)");
  console.log("  GET  /api/hourly       - Last N raw readings (add ?device_id=ESP32_001&limit=60)");
  console.log("  GET  /api/history      - Preset history (preset=60s|60m|24h|7d|day&date=YYYY-MM-DD)");
  console.log("  GET  /api/devices      - List devices with coordinates");
  console.log("  GET  /api/devices/:id  - Single device info");
});
