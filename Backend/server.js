const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = 8080;

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'noisesensor',
  password: process.env.DB_PASSWORD,
  port: 5432,
});

// Test database connection
pool.connect((err) => {
  if (err) {
    console.error('Database connection failed:', err);
  } else {
    console.log('Connected to PostgreSQL database!');
  }
});

// Create table with device_id support
const createTableQuery = `
  CREATE TABLE IF NOT EXISTS noise_readings (
    id SERIAL PRIMARY KEY,
    device_id VARCHAR(50) DEFAULT 'ESP32_001',
    dba_instant DECIMAL(5,2) NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

pool.query(createTableQuery, (err) => {
  if (err) {
    console.error('Error creating table:', err);
  } else {
    console.log('Table "noise_readings" is ready with device_id support');
  }
});

// =================== API ENDPOINTS ===================

// POST endpoint for ESP32 to send data
app.post('/api/noise-data', async (req, res) => {
  const { dba_instant, device_id } = req.body;

  if (dba_instant === undefined || dba_instant === null) {
    return res.status(400).json({ error: 'dba_instant is required' });
  }

  const deviceName = device_id || 'ESP32_001';

  try {
    const result = await pool.query(
      'INSERT INTO noise_readings (device_id, dba_instant) VALUES ($1, $2) RETURNING *',
      [deviceName, dba_instant]
    );
    console.log(`[${deviceName}] Stored: ${dba_instant} dBA`);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error inserting data:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET endpoint for frontend to fetch latest reading
app.get('/api/live', async (req, res) => {
  const { device_id } = req.query;

  try {
    let query = 'SELECT * FROM noise_readings';
    const params = [];

    if (device_id) {
      query += ' WHERE device_id = $1';
      params.push(device_id);
    }

    query += ' ORDER BY timestamp DESC LIMIT 1';

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res.json({ dba_instant: 0 });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET endpoint for frontend to fetch raw historical data (last N readings)
app.get('/api/hourly', async (req, res) => {
  const { device_id, limit } = req.query;
  const recordLimit = limit ? parseInt(limit, 10) : 60;

  try {
    let query = 'SELECT * FROM noise_readings';
    const params = [];

    if (device_id) {
      query += ' WHERE device_id = $1';
      params.push(device_id);
    }

    // DESC then reverse => oldest first in response
    query += ` ORDER BY timestamp DESC LIMIT ${Number.isFinite(recordLimit) ? recordLimit : 60}`;

    const result = await pool.query(query, params);
    res.json(result.rows.reverse()); // oldest first
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// GET list of all devices
app.get('/api/devices', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT DISTINCT device_id FROM noise_readings ORDER BY device_id'
    );
    res.json(result.rows.map(r => r.device_id));
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// =================== PRESET HISTORY ENDPOINT ===================
// Presets:
//   preset=60s  -> last 60 raw seconds (DESC LIMIT 60 => we reverse to oldest->newest)
//   preset=60m  -> last 60 minutes, avg per minute (already ORDER BY ASC)
//   preset=24h  -> last 24 hours, avg per hour (already ORDER BY ASC)
//   preset=7d   -> last 7 days, avg per day (already ORDER BY ASC)
//   preset=day&date=YYYY-MM-DD -> selected day, avg per hour (already ORDER BY ASC)
app.get('/api/history', async (req, res) => {
  const { device_id = 'ESP32_001', preset, date } = req.query;

  let query = '';
  let params = [device_id];

  try {
    switch (preset) {
      case '60s':
        query = `
          SELECT timestamp, dba_instant::float AS dba
          FROM noise_readings
          WHERE device_id = $1
          ORDER BY timestamp DESC
          LIMIT 60
        `;
        break;

      case '60m':
        query = `
          SELECT
            date_trunc('minute', timestamp) AS timestamp,
            AVG(dba_instant)::float AS dba
          FROM noise_readings
          WHERE device_id = $1
            AND timestamp >= NOW() - INTERVAL '60 minutes'
          GROUP BY 1
          ORDER BY 1
        `;
        break;

      case '24h':
        query = `
          SELECT
            date_trunc('hour', timestamp) AS timestamp,
            AVG(dba_instant)::float AS dba
          FROM noise_readings
          WHERE device_id = $1
            AND timestamp >= NOW() - INTERVAL '24 hours'
          GROUP BY 1
          ORDER BY 1
        `;
        break;

      case '7d':
        query = `
          SELECT
            date_trunc('day', timestamp) AS timestamp,
            AVG(dba_instant)::float AS dba
          FROM noise_readings
          WHERE device_id = $1
            AND timestamp >= NOW() - INTERVAL '7 days'
          GROUP BY 1
          ORDER BY 1
        `;
        break;

      case 'day':
        if (!date) {
          return res.status(400).json({ error: 'date is required (YYYY-MM-DD)' });
        }
        params.push(date);
        query = `
          SELECT
            date_trunc('hour', timestamp) AS timestamp,
            AVG(dba_instant)::float AS dba
          FROM noise_readings
          WHERE device_id = $1
            AND timestamp >= $2::date
            AND timestamp < ($2::date + INTERVAL '1 day')
          GROUP BY 1
          ORDER BY 1
        `;
        break;

      default:
        return res.status(400).json({
          error: 'Invalid preset. Use preset=60s|60m|24h|7d or preset=day&date=YYYY-MM-DD'
        });
    }

    const result = await pool.query(query, params);

    // IMPORTANT: only reverse for 60s (because that query is DESC LIMIT 60)
    if (preset === '60s') {
      res.json(result.rows.reverse()); // oldest -> newest
    } else {
      res.json(result.rows); // already oldest -> newest
    }
  } catch (err) {
    console.error('History query failed:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  console.log('Available endpoints:');
  console.log('  POST /api/noise-data      - ESP32 sends data');
  console.log('  GET  /api/live            - Latest reading (add ?device_id=ESP32_001)');
  console.log('  GET  /api/hourly          - Last N raw readings (add ?device_id=ESP32_001&limit=60)');
  console.log('  GET  /api/devices         - List all device IDs');
  console.log('  GET  /api/history         - Preset history (preset=60s|60m|24h|7d|day&date=YYYY-MM-DD)');
});
