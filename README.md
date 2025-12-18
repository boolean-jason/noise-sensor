# healthmap-noisesensor

Noise monitoring system using an ESP32 (I2S mic + OLED), a Node/Express backend with PostgreSQL storage, and a React (Vite) dashboard.

## Architecture

- ESP32 reads microphone audio → calculates dB(A) → sends JSON to backend (POST /api/noise-data)

- Backend (Node/Express) stores readings in PostgreSQL and exposes API endpoints for the dashboard

- Frontend (React/Vite) displays live and historical charts by fetching data from the backend

## Requirements

- Node.js (LTS recommended)

- PostgreSQL (local via pgAdmin/Postgres install)

- ESP32 + I2S microphone (e.g., SPH0645) + SSD1306 OLED

- Arduino IDE or PlatformIO


## Frontend

Do ```Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned```
and select Y. Then :
```
cd frontend/
npm install
npm run dev
```

## Backend

```
cd backend/
node server.js
```

## ESP32
Before uploading the code, you must update your WiFi credentials:

```
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
```
Replace these with the SSID and password of the WiFi network you want the ESP32 to connect to.

Once the ESP32 is powered and connected, it will print its local IP address in the Serial Monitor, for example:

```
Connected! IP: 192.168.0.128
HTTP server started on /api/live
```

You can then access the live noise value at:
```
http://<ESP_IP>/api/live
```

The endpoint returns JSON such as:
```
{ "dba_instant": 56.42 }
```
