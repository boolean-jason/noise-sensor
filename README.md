# healthmap-noisesensor

Noise monitoring system using an ESP32 (I2S microphone + OLED), a Node/Express backend with PostgreSQL storage, and a React (Vite) dashboard.

The system continuously measures environmental noise in dB(A), stores the measurements in a database, and visualizes both live and historical noise levels in a web dashboard.

---

## Architecture

- **ESP32**
  - Reads audio from an I2S microphone
  - Calculates instantaneous dB(A)
  - Displays live values and a small graph on an OLED
  - Sends one measurement per second to the backend via HTTP (JSON)

- **Backend (Node.js / Express)**
  - Receives measurements from the ESP32
  - Stores data in a PostgreSQL database
  - Provides API endpoints for live and historical data

- **Frontend (React / Vite)**
  - Fetches data from the backend
  - Shows:
    - Live noise level (last seconds)
    - Historical charts (60s, 60m, 24h, 7d, single day)
  - Automatically switches between day/night thresholds

Data flow:

ESP32 → Backend API → PostgreSQL
<br>
Frontend Dashboard → Backend API → PostgreSQL

---

## Requirements

- Node.js (LTS recommended)
- PostgreSQL (local installation, e.g. via pgAdmin)
- ESP32 with:
  - I2S microphone (e.g. SPH0645)
  - SSD1306 OLED display
- Arduino IDE or PlatformIO
- Frontend libraries:
  - React (Vite)
  - Leaflet (interactive map for sensor selection)

---

## Backend Setup

### Environment variables

Create a file:

`backend/.env`

```env
DB_PASSWORD=your_postgres_password
PORT=8080
```

### Install and run backend

```bash
cd backend/
npm install
node server.js
```

Backend runs at:

`http://localhost:8080`

The backend automatically:
- Connects to PostgreSQL
- Creates the table `noise_readings` if it does not exist

---

## Database Schema

Table: `noise_readings`

- `id` (SERIAL, primary key)
- `device_id` (VARCHAR)
- `dba_instant` (DECIMAL)
- `timestamp` (TIMESTAMP, auto-generated)

Table: `devices`

- `device_id` (VARCHAR, primary key)
- `label` (TEXT)
- `address` (TEXT)
- `latitude` (DOUBLE PRECISION, GPS latitude)
- `longitude` (DOUBLE PRECISION, GPS longitude)
- `created_at` (TIMESTAMP, auto-generated)

## Relationship

- `noise_readings.device_id` references `devices.device_id`
- One device can have many noise readings

---

## Backend API Endpoints

### Store noise data (ESP32 → backend)

POST `/api/noise-data`

```json
{
  "device_id": "ESP32_001",
  "dba_instant": 56.35
}
```

### Latest reading

GET `/api/live?device_id=ESP32_001`

```json
{
  "id": 855,
  "device_id": "ESP32_001",
  "dba_instant": "56.35",
  "timestamp": "2025-12-17T23:03:52.154Z"
}
```

### Historical data (presets)

GET `/api/history`

Presets:

- `preset=60s`  → last 60 seconds (raw values)
- `preset=60m`  → last 60 minutes (average per minute)
- `preset=24h`  → last 24 hours (average per hour)
- `preset=7d`   → last 7 days (average per day)
- `preset=day&date=YYYY-MM-DD` → selected day (average per hour)

Example:

`/api/history?device_id=ESP32_001&preset=60m`

---

## Frontend Setup

```bash
cd frontend/
npm install

#run locally
npm run dev

# run on local network
npm run dev -- --host 0.0.0.0 --port 5173
```

Frontend runs at:

`http://localhost:5173`
`http://<IP>:5173`

### Backend URL config

Create:

`frontend/.env`

```env
VITE_BACKEND_URL=http://localhost:8080
```

---

## ESP32 Setup

### WiFi credentials

```cpp
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
```

### Backend URL and device ID

```cpp
const char* BACKEND_URL = "http://192.168.0.240:8080/api/noise-data";
const char* DEVICE_ID = "ESP32_001";
```

### ESP32 behavior

- Sends one measurement per second
- OLED works independently from the backend
- If backend is offline:
  - OLED keeps updating
  - Network errors do not block the loop

---

### Adding a new ESP32 device

This project supports multiple ESP32 noise sensors without changing backend or frontend code.

To add a new device, follow these steps:

---

## Notes

- Historical charts (60m / 24h / 7d / day) show averaged values
- Live charts show raw per-second data
- Data retention (e.g. delete data older than 3 months) can be handled in PostgreSQL

---

## Deployment (future)

To make the dashboard available outside your local network:

- Frontend: Vercel or Netlify
- Backend: Render / Railway / Fly.io
- Database: Neon / Supabase

Before public deployment:
- Add API key authentication for ESP32
- Restrict CORS
- Add rate limiting

---

## License

Educational and research use.
