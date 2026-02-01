# healthmap-noisesensor

Noise monitoring system using an ESP32 (I2S microphone + OLED), a Node/Express backend with PostgreSQL storage, and a React (Vite) dashboard.

The system continuously measures environmental noise in dB(A), stores the measurements in a database, and visualizes both live and historical noise levels in a web dashboard.

This repository contains:
- ESP32 firmware (noise sensing + OLED visualization)
- Backend API (data ingestion and storage)
- Frontend dashboard (visualization and device selection)

---

## Architecture Overview

### ESP32
- Reads raw audio from an I2S MEMS microphone (e.g. SPH0645)
- Processes audio into instantaneous dB(A) values
- Displays live values and a small real-time graph on an SSD1306 OLED
- Sends one measurement per second to the backend via HTTP (JSON)
- Continues operating locally even if the backend is offline

### Backend (Node.js / Express)
- Receives measurements from one or more ESP32 devices
- Stores data in a PostgreSQL database
- Exposes REST API endpoints for live and historical data
- Automatically creates required tables on startup

### Frontend (React / Vite)
- Fetches data from the backend API
- Displays:
  - Live noise levels (last seconds)
  - Historical charts (60s, 60m, 24h, 7d, selected day)
  - Device selector and interactive map
- Automatically applies day/night noise thresholds

### Data Flow

ESP32 → Backend API → PostgreSQL  
Frontend Dashboard → Backend API → PostgreSQL

---

## System Requirements

### Software
- Node.js (LTS recommended)
- PostgreSQL (local installation, e.g. via pgAdmin)
- Arduino IDE or PlatformIO
- Git

### Hardware
- ESP32 development board
- I2S MEMS microphone (e.g. SPH0645)
- SSD1306 OLED display (I2C)

### Frontend Libraries
- React (Vite)
- Leaflet (interactive map)

---

## Backend Setup

### 1. Environment variables

Create the file:

`backend/.env`

```env
DB_PASSWORD=your_postgres_password
PORT=8080
```

Make sure PostgreSQL is running and accessible locally.

---

### 2. Install dependencies and start backend

```bash
cd backend/
npm install
node server.js
```

Backend runs at:

`http://localhost:8080`

On startup, the backend will:
- Connect to PostgreSQL
- Create required tables if they do not exist

---

## Database Schema

### Table: `noise_readings`
- `id` (SERIAL, primary key)
- `device_id` (VARCHAR)
- `dba_instant` (DECIMAL)
- `timestamp` (TIMESTAMP, auto-generated)

### Table: `devices`
- `device_id` (VARCHAR, primary key)
- `label` (TEXT)
- `address` (TEXT)
- `latitude` (DOUBLE PRECISION)
- `longitude` (DOUBLE PRECISION)
- `created_at` (TIMESTAMP, auto-generated)

### Relationship
- `noise_readings.device_id` references `devices.device_id`

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

---

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

---

### Historical data

GET `/api/history`

Supported presets:
- `preset=60s`   → last 60 seconds (raw)
- `preset=60m`   → last 60 minutes (average per minute)
- `preset=24h`   → last 24 hours (average per hour)
- `preset=7d`    → last 7 days (average per day)
- `preset=day&date=YYYY-MM-DD` → selected day (average per hour)

Example:
```
/api/history?device_id=ESP32_001&preset=60m
```

---

## Frontend Setup

```bash
cd frontend/
npm install

# run locally
npm run dev

# run on local network
npm run dev -- --host 0.0.0.0 --port 5173
```

Frontend runs at:
- `http://localhost:5173`
- `http://<YOUR_IP>:5173`

---

### Backend URL configuration

Create:

`frontend/.env`

```env
VITE_BACKEND_URL=http://localhost:8080
```

---

## ESP32 Setup

### 1. Wi-Fi credentials

Set your Wi-Fi credentials in the ESP32 firmware:

```cpp
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
```

---

### 2. Backend URL and device ID

Replace `<YOUR_IP>` with the IPv4 address of the machine running the backend.

```cpp
const char* BACKEND_URL = "http://<YOUR_IP>:8080/api/noise-data";
const char* DEVICE_ID = "ESP32_001";
```

---

### 3. Upload firmware

- Connect the ESP32 via USB
- Select the correct board and port
- Upload the firmware
- Power the ESP32

---

## Adding a New ESP32 Device

1. Set a unique device ID in firmware
2. Upload firmware to ESP32
3. Register device location in PostgreSQL

```sql
INSERT INTO devices (device_id, label, address, latitude, longitude)
VALUES ('ESP32_003', 'Paris', 'Rue de Rivoli, Paris', 48.856613, 2.352222);
```

---

## Notes

- Live charts show raw per-second data
- Historical charts show averaged values
- OLED works independently from backend availability
- Data retention should be handled at database level

---

## License

Educational and research use only.
