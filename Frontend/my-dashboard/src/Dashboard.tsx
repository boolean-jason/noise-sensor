import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  AreaChart,
  Area,
} from "recharts";

import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import Logo from "./assets/logo.png";

// ---- Backend ----
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8080";

// ---- Types ----
type LivePoint = { t: number; dba: number };

type HistoryPoint = { timestamp: string; dba: number };

type Device = {
  device_id: string;
  label: string;
  address?: string;
  latitude: number;
  longitude: number;
  created_at?: string;
};

type Preset = "60s" | "60m" | "24h" | "7d" | "day";
const PRESETS: { value: Preset; label: string }[] = [
  { value: "60s", label: "Last 60 seconds" },
  { value: "60m", label: "Last 60 minutes" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "day", label: "Single day (24h)" },
];

// ---- Themes ----
const THEMES = {
  light: {
    name: "light" as const,
    bg: "#ffffff",
    ink: "#111827",
    panel: "#ffffff",
    border: "#e5e7eb",
    grid: "#e5e7eb",
    primary: "#E11D48",
    primaryFill: "#FCE7F3",
    tooltipBg: "#ffffff",
  },
  dark: {
    name: "dark" as const,
    bg: "#0e1a2b",
    ink: "#e6eef7",
    panel: "#152235",
    border: "#23344e",
    grid: "#23344e",
    primary: "#31c48d",
    primaryFill: "rgba(49,196,141,0.25)",
    tooltipBg: "#152235",
  },
};

function getIsNightNow() {
  const h = new Date().getHours();
  return h >= 22 || h < 7;
}

function formatTime(ts: number | string) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function classify(dba: number, night: boolean) {
  const limit = night ? 45 : 55;
  if (dba <= limit - 5) return { label: "OK", color: "#10B981" };
  if (dba <= limit + 5) return { label: "CAUTION", color: "#F59E0B" };
  return { label: "HIGH", color: "#DC2626" };
}

// --- Leaflet marker icon fix (Vite) ---
const markerIcon = new L.Icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

export default function Dashboard() {
  // ---------- Theme ----------
  const [mode, setMode] = useState<"light" | "dark">("light");
  const theme = mode === "light" ? THEMES.light : THEMES.dark;

  useEffect(() => {
    const saved = localStorage.getItem("ng-theme");
    if (saved === "light" || saved === "dark") setMode(saved);
  }, []);
  useEffect(() => {
    localStorage.setItem("ng-theme", mode);
  }, [mode]);

  // ---------- Auto day/night ----------
  const [isNight, setIsNight] = useState(getIsNightNow());
  useEffect(() => {
    const id = setInterval(() => setIsNight(getIsNightNow()), 60_000);
    return () => clearInterval(id);
  }, []);

  // ---------- Cards ----------
  const cardStyle: React.CSSProperties = {
    background: theme.panel,
    borderRadius: 16,
    padding: 16,
    border: `1px solid ${theme.border}`,
    boxShadow: "0 4px 16px rgba(0,0,0,0.05)",
  };

  // ---------- Devices ----------
  const [devices, setDevices] = useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");

  const selectedDevice = useMemo(
    () => devices.find((d) => d.device_id === selectedDeviceId),
    [devices, selectedDeviceId]
  );

  useEffect(() => {
    const fetchDevices = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/devices`);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data: Device[] = await res.json();
        setDevices(data);
        if (!selectedDeviceId && data.length > 0) setSelectedDeviceId(data[0].device_id);
      } catch (err) {
        console.error("Could not fetch devices:", err);
      }
    };

    fetchDevices();
    const id = setInterval(fetchDevices, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Live ----------
  const LIVE_POINTS = 20;
  const [live, setLive] = useState<LivePoint[]>([]);
  const [liveStatus, setLiveStatus] = useState<
    { kind: "idle" | "loading" | "ok" | "unavailable"; message?: string; lastSeen?: string }
  >({ kind: "idle" });

  const liveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!selectedDeviceId) return;

    setLive([]);
    setLiveStatus({ kind: "loading" });

    if (liveTimerRef.current) {
      window.clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }

    const fetchLive = async () => {
      try {
        const res = await fetch(
          `${BACKEND_URL}/api/live?device_id=${encodeURIComponent(selectedDeviceId)}`
        );
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        const dbaRaw = data?.dba_instant;
        const dba = Number.parseFloat(dbaRaw);

        const ts = data?.timestamp ? new Date(data.timestamp).toISOString() : undefined;

        if (!Number.isFinite(dba) || (dba === 0 && !data?.timestamp)) {
          setLiveStatus({
            kind: "unavailable",
            message:
              "No live data for this sensor yet. The ESP32 may be offline, not sending, or writing to a different database.",
          });
          return;
        }

        if (ts) {
          const ageMs = Date.now() - new Date(ts).getTime();
          if (ageMs > 30_000) {
            setLiveStatus({
              kind: "unavailable",
              message:
                "No recent live data. Last reading is older than 30 seconds (ESP32 offline / wrong DEVICE_ID / backend not receiving).",
              lastSeen: ts,
            });
            return;
          }
        }

        const now = Date.now();
        setLive((prev) => [...prev.slice(-(LIVE_POINTS - 1)), { t: now, dba }]);
        setLiveStatus({ kind: "ok", lastSeen: ts });
      } catch (err) {
        setLiveStatus({
          kind: "unavailable",
          message:
            "Could not reach backend for live data (backend down / wrong BACKEND_URL / network issue).",
        });
      }
    };

    fetchLive();
    liveTimerRef.current = window.setInterval(fetchLive, 1000);

    return () => {
      if (liveTimerRef.current) {
        window.clearInterval(liveTimerRef.current);
        liveTimerRef.current = null;
      }
    };
  }, [selectedDeviceId]);

  const current = live[live.length - 1]?.dba ?? 0;
  const status = classify(current, isNight);

  // ---------- History ----------
  const [preset, setPreset] = useState<Preset>("60m");
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [history, setHistory] = useState<HistoryPoint[]>([]);

  useEffect(() => {
    if (!selectedDeviceId) return;

    const fetchHistory = async () => {
      try {
        let url = `${BACKEND_URL}/api/history?device_id=${encodeURIComponent(
          selectedDeviceId
        )}&preset=${preset}`;
        if (preset === "day") url += `&date=${selectedDate}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data: HistoryPoint[] = await res.json();
        setHistory(data);
      } catch (err) {
        console.error("Could not fetch historical data:", err);
        setHistory([]);
      }
    };

    fetchHistory();
    const refreshMs = preset === "60s" ? 5000 : 60_000;
    const id = setInterval(fetchHistory, refreshMs);
    return () => clearInterval(id);
  }, [preset, selectedDate, selectedDeviceId]);

  const historicalChartData = useMemo(() => {
    return history.map((p) => ({
      time: new Date(p.timestamp).getTime(),
      dba: p.dba,
    }));
  }, [history]);

  const historyTitle = useMemo(() => {
    switch (preset) {
      case "60s":
        return "History (Last 60 seconds)";
      case "60m":
        return "History (Last 60 minutes)";
      case "24h":
        return "History (Last 24 hours)";
      case "7d":
        return "History (Last 7 days)";
      case "day":
        return `History (Selected day: ${selectedDate})`;
      default:
        return "History";
    }
  }, [preset, selectedDate]);

  const mapCenter: [number, number] = useMemo(() => {
    if (selectedDevice) return [selectedDevice.latitude, selectedDevice.longitude];
    return [51.0, 10.0];
  }, [selectedDevice]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: theme.bg,
        color: theme.ink,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif",
        padding: 24,
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 18,
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: theme.ink }}>
          Nightingale · Noise Monitoring Dashboard
        </h1>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            onClick={() => setMode(mode === "light" ? "dark" : "light")}
            style={{
              background: theme.primary,
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "6px 12px",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 700,
            }}
          >
            {mode === "light" ? "Switch to Dark Mode" : "Switch to Light Mode"}
          </button>
          <div style={{ opacity: 0.7 }}>Live from Database</div>
        </div>
      </header>

      {/* Layout */}
      <div
        style={{
          display: "grid",
          // CHANGED: right column smaller (~30% less), left column bigger
          gridTemplateColumns: "1.55fr 0.95fr",
          gap: 16,
          alignItems: "stretch",
        }}
      >
        {/* LEFT */}
        <div style={{ display: "grid", gridTemplateRows: "auto 1fr", gap: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 16 }}>
            {/* Logo card */}
            <div style={{ ...cardStyle, padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 800, opacity: 0.8, marginBottom: 10 }}>
                Innovation in Medicine
              </div>
              <div
                style={{
                  width: "100%",
                  height: 140,
                  borderRadius: 12,
                  overflow: "hidden",
                  border: `1px solid ${theme.border}`,
                  background: theme.bg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <img
                  src={Logo}
                  alt="Nightingale logo"
                  style={{ width: "100%", height: "100%", objectFit: "contain" }}
                />
              </div>

              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
                Selected sensor:
                <div style={{ marginTop: 4, fontWeight: 800, opacity: 0.95 }}>
                  {selectedDevice?.device_id ?? "—"}{" "}
                  {selectedDevice?.label ? `(${selectedDevice.label})` : ""}
                </div>
              </div>
            </div>

            {/* Info card */}
            <div style={cardStyle}>
              <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6 }}>
                Noise & Heart Health
              </div>

              <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.45 }}>
                Chronic noise exposure raises stress hormones, disrupts sleep, and impairs vascular
                function-linked to hypertension and ischemic heart disease.
              </div>

              <div style={{ fontSize: 12, opacity: 0.85, marginTop: 10 }}>
                WHO limits: <b>≤55 dB</b> day (<i>Lden</i>), <b>≤45 dB</b> night (<i>Lnight</i>)
              </div>

              <div
                style={{
                  marginTop: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 13, opacity: 0.9 }}>
                  Mode: <b>{isNight ? "Night" : "Day"}</b>
                </div>

                <span
                  style={{
                    background: status.color,
                    color: "#fff",
                    borderRadius: 999,
                    padding: "4px 10px",
                    fontSize: 12,
                    fontWeight: 800,
                  }}
                >
                  {status.label}
                </span>
              </div>

              {selectedDevice?.address && (
                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                  {selectedDevice.address}
                </div>
              )}
            </div>
          </div>

          {/* History */}
          <div style={cardStyle}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 10,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 800, opacity: 0.95 }}>
                {historyTitle}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <label style={{ fontSize: 12, opacity: 0.85 }}>
                  View:&nbsp;
                  <select
                    value={preset}
                    onChange={(e) => setPreset(e.target.value as Preset)}
                    style={{
                      background: theme.bg,
                      color: theme.ink,
                      border: `1px solid ${theme.border}`,
                      borderRadius: 8,
                      padding: "4px 8px",
                    }}
                  >
                    {PRESETS.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>

                {preset === "day" && (
                  <input
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    style={{
                      background: theme.bg,
                      color: theme.ink,
                      border: `1px solid ${theme.border}`,
                      borderRadius: 8,
                      padding: "4px 8px",
                    }}
                  />
                )}

                <div style={{ fontSize: 12, opacity: 0.7 }}>{history.length} points</div>
              </div>
            </div>

            <div style={{ height: 420 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={historicalChartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="time"
                    tick={{ fill: theme.ink }}
                    tickFormatter={(value) => formatTime(value)}
                    interval="preserveStartEnd"
                    minTickGap={32}
                  />
                  <YAxis domain={[35, 85]} tick={{ fill: theme.ink }} tickFormatter={(v) => `${v} dB`} />
                  <Tooltip
                    labelFormatter={(value) => formatTime(value as number)}
                    contentStyle={{
                      background: theme.tooltipBg,
                      border: `1px solid ${theme.border}`,
                      color: theme.ink,
                    }}
                  />
                  <Area type="monotone" dataKey="dba" name="dB(A)" stroke={theme.primary} fill={theme.primaryFill} fillOpacity={0.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* RIGHT */}
        <div style={{ display: "grid", gridTemplateRows: "auto 1fr", gap: 16 }}>
          {/* Map */}
          <div style={{ ...cardStyle, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 800, opacity: 0.95 }}>Map (select a sensor)</div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                Devices: <b>{devices.length}</b>
              </div>
            </div>

            <div style={{ height: 260, borderRadius: 12, overflow: "hidden", border: `1px solid ${theme.border}` }}>
              <MapContainer center={mapCenter} zoom={6} style={{ height: "100%", width: "100%" }}>
                <TileLayer
                  attribution='&copy; OpenStreetMap contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />

                {devices.map((d) => (
                  <Marker
                    key={d.device_id}
                    position={[d.latitude, d.longitude]}
                    icon={markerIcon}
                    eventHandlers={{
                      click: () => setSelectedDeviceId(d.device_id),
                    }}
                  >
                    <Popup>
                      <div style={{ fontWeight: 800 }}>{d.device_id}</div>
                      <div style={{ fontSize: 12 }}>{d.label}</div>
                      {d.address && <div style={{ fontSize: 12, marginTop: 4 }}>{d.address}</div>}
                      <div style={{ fontSize: 11, opacity: 0.75, marginTop: 6 }}>
                        Lat: {d.latitude.toFixed(6)}<br />
                        Lon: {d.longitude.toFixed(6)}
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
              <div style={{ fontSize: 12, opacity: 0.85 }}>Quick select:</div>
              <select
                value={selectedDeviceId}
                onChange={(e) => setSelectedDeviceId(e.target.value)}
                style={{
                  background: theme.bg,
                  color: theme.ink,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 8,
                  padding: "4px 8px",
                }}
              >
                {devices.map((d) => (
                  <option key={d.device_id} value={d.device_id}>
                    {d.device_id} - {d.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Live */}
          <div style={cardStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 }}>
              <div style={{ fontSize: 14, fontWeight: 800, opacity: 0.95 }}>
                Live (last ~{LIVE_POINTS}s)
              </div>

              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  {isNight ? "Night limit ~45 dB" : "Day limit ~55 dB"}
                </div>

                <div style={{ fontSize: 34, fontWeight: 900, color: theme.primary, lineHeight: 1 }}>
                  {liveStatus.kind === "ok" ? current.toFixed(1) : "—"}
                </div>

                <div style={{ fontSize: 12, opacity: 0.7 }}>dB(A)</div>
              </div>
            </div>

            {liveStatus.kind !== "ok" ? (
              <div
                style={{
                  border: `1px dashed ${theme.border}`,
                  borderRadius: 12,
                  padding: 14,
                  background: theme.bg,
                }}
              >
                <div style={{ fontWeight: 800, marginBottom: 6 }}>
                  Live data not available
                </div>

                <div style={{ fontSize: 13, opacity: 0.85, lineHeight: 1.4 }}>
                  {liveStatus.kind === "loading"
                    ? "Loading live data…"
                    : liveStatus.message ??
                      "No data received for this device."}
                </div>

                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
                  Device: <b>{selectedDeviceId || "—"}</b>
                </div>
                {liveStatus.lastSeen && (
                  <div style={{ marginTop: 4, fontSize: 12, opacity: 0.75 }}>
                    Last seen: {new Date(liveStatus.lastSeen).toLocaleString()}
                  </div>
                )}

                <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                  Tip: check ESP32 <b>DEVICE_ID</b>, WiFi, backend URL, and that it writes to the same database.
                </div>
              </div>
            ) : (
              <div style={{ height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={live} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="t"
                      tick={{ fill: theme.ink }}
                      tickFormatter={(value) => formatTime(value as number)}
                      interval="preserveStartEnd"
                      minTickGap={28}
                    />
                    <YAxis domain={[35, 85]} tick={{ fill: theme.ink }} tickFormatter={(v) => `${v} dB`} />
                    <Tooltip
                      labelFormatter={(value) => formatTime(value as number)}
                      contentStyle={{
                        background: theme.tooltipBg,
                        border: `1px solid ${theme.border}`,
                        color: theme.ink,
                      }}
                    />
                    <Line type="monotone" dataKey="dba" stroke={theme.primary} strokeWidth={2.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </div>
      </div>

      <footer style={{ textAlign: "center", opacity: 0.65, fontSize: 12, marginTop: 18 }}>
        © {new Date().getFullYear()} Nightingale - Live data from PostgreSQL
      </footer>
    </div>
  );
}
