// src/Dashboard.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  AreaChart, Area
} from "recharts";

// ---- Backend ----
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://localhost:8080";
const DEVICE_ID = "ESP32_001";

// ---- Types ----
type LivePoint = { t: number; dba: number };
type HistoryPoint = { timestamp: string; dba: number };

type Preset = "60s" | "60m" | "24h" | "7d" | "day";

const PRESETS: { value: Preset; label: string }[] = [
  { value: "60s", label: "Last 60 seconds" },
  { value: "60m", label: "Last 60 minutes" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "day", label: "Single day (24h)" },
];

// ---- Themes (oude dashboard look) ----
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
  return h >= 22 || h < 7; // WHO Nighttime
}

export default function Dashboard() {
  // ---------- Live chart ----------
  const [live, setLive] = useState<LivePoint[]>([]);

  // Live buffer: 20 punten (last ~20 sec)
  const LIVE_POINTS = 20;

  // ---------- Historical chart ----------
  const [preset, setPreset] = useState<Preset>("60m");
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [history, setHistory] = useState<HistoryPoint[]>([]);

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
    // update elke minuut zodat hij vanzelf omschakelt
    const id = setInterval(() => setIsNight(getIsNightNow()), 60_000);
    return () => clearInterval(id);
  }, []);

  // ---------- Helpers ----------
  const formatTime = (ts: number | string) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  function classify(dba: number, night: boolean) {
    const limit = night ? 45 : 55;
    if (dba <= limit - 5) return { label: "OK", color: "#10B981" };
    if (dba <= limit + 5) return { label: "CAUTION", color: "#F59E0B" };
    return { label: "HIGH", color: "#DC2626" };
  }

  // ---------- Fetch LIVE every second ----------
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/live?device_id=${DEVICE_ID}`);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        const now = Date.now();
        const dba = parseFloat(data.dba_instant) || 0;

        setLive((prev) => [...prev.slice(-(LIVE_POINTS - 1)), { t: now, dba }]);
      } catch (err) {
        console.error("Could not fetch live data:", err);
      }
    }, 1000);

    return () => clearInterval(id);
  }, []);

  // ---------- Fetch HISTORY (presets) ----------
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        let url = `${BACKEND_URL}/api/history?device_id=${DEVICE_ID}&preset=${preset}`;
        if (preset === "day") url += `&date=${selectedDate}`;

        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();

        // data = [{timestamp, dba}, ...]
        setHistory(data);
      } catch (err) {
        console.error("Could not fetch historical data:", err);
      }
    };

    fetchHistory();

    // Refresh cadence: sneller bij 60s, anders rustiger
    const refreshMs = preset === "60s" ? 5000 : 60000;
    const id = setInterval(fetchHistory, refreshMs);
    return () => clearInterval(id);
  }, [preset, selectedDate]);

  const current = live[live.length - 1]?.dba ?? 0;
  const status = classify(current, isNight);

  // Transform history data for chart
  const historicalChartData = useMemo(() => {
    return history.map((p) => ({
      time: new Date(p.timestamp).getTime(),
      dba: p.dba,
    }));
  }, [history]);

  // Labels
  const historyTitle = useMemo(() => {
    switch (preset) {
      case "60s": return "Historical (Last 60 seconds)";
      case "60m": return "Historical (Last 60 minutes)";
      case "24h": return "Historical (Last 24 hours)";
      case "7d":  return "Historical (Last 7 days)";
      case "day": return `Historical (Selected day: ${selectedDate})`;
      default:    return "Historical";
    }
  }, [preset, selectedDate]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: theme.bg,
        color: theme.ink,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif",
        padding: "24px",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 24,
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
            title="Toggle theme"
          >
            {mode === "light" ? "Switch to Dark Mode" : "Switch to Light Mode"}
          </button>
          <div style={{ opacity: 0.7 }}>Live from Database</div>
        </div>
      </header>

      {/* Top row: Info / KPI / Live chart */}
      <section
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr 2fr",
          gap: 16,
          marginBottom: 16,
        }}
      >
        {/* Info card */}
        <div
          style={{
            background: theme.panel,
            borderRadius: 16,
            padding: 16,
            border: `1px solid ${theme.border}`,
            boxShadow: "0 4px 16px rgba(0,0,0,0.05)",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700 }}>Noise & Heart Health</div>
          <p style={{ margin: 0, fontSize: 15, opacity: 0.9 }}>
            Chronic noise exposure raises stress hormones, disrupts sleep,
            and impairs vascular function-linked to hypertension and ischemic heart disease.
          </p>

          <div style={{ fontSize: 13, opacity: 0.9 }}>
            WHO limits: <b>≤55 dB</b> day (<i>Lden</i>), <b>≤45 dB</b> night (<i>Lnight</i>)
          </div>

          <div
            style={{
              marginTop: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
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
        </div>

        {/* KPI card */}
        <div
          style={{
            background: theme.panel,
            borderRadius: 16,
            padding: 16,
            border: `1px solid ${theme.border}`,
            boxShadow: "0 4px 16px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ fontSize: 14, opacity: 0.8, marginBottom: 8 }}>
            Live dB(A)
          </div>
          <div
            style={{
              fontSize: 48,
              fontWeight: 800,
              lineHeight: 1,
              color: theme.primary,
            }}
          >
            {current.toFixed(1)}
          </div>
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 8 }}>
            {isNight ? "Night limit ~45 dB" : "Day limit ~55 dB"} · Live points: {LIVE_POINTS}
          </div>
        </div>

        {/* Live chart card */}
        <div
          style={{
            background: theme.panel,
            borderRadius: 16,
            padding: 16,
            border: `1px solid ${theme.border}`,
            boxShadow: "0 4px 16px rgba(0,0,0,0.05)",
          }}
        >
          <div style={{ fontSize: 14, opacity: 0.8, marginBottom: 8 }}>
            Live Noise Levels (last ~{LIVE_POINTS}s)
          </div>

          <div style={{ height: 240 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={live} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" />
                <XAxis
                  dataKey="t"
                  tick={{ fill: theme.ink }}
                  tickFormatter={(value) => formatTime(value as number)}
                  interval={1}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  domain={[35, 85]}
                  tick={{ fill: theme.ink }}
                  tickFormatter={(v) => `${v} dB`}
                />
                <Tooltip
                  labelFormatter={(value) => formatTime(value as number)}
                  contentStyle={{
                    background: theme.tooltipBg,
                    border: `1px solid ${theme.border}`,
                    color: theme.ink,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="dba"
                  stroke={theme.primary}
                  strokeWidth={2.5}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* Historical chart */}
      <section
        style={{
          background: theme.panel,
          borderRadius: 16,
          padding: 16,
          border: `1px solid ${theme.border}`,
          boxShadow: "0 4px 16px rgba(0,0,0,0.05)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ fontSize: 14, opacity: 0.9, fontWeight: 700 }}>
            {historyTitle}
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
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
                  <option key={p.value} value={p.value}>{p.label}</option>
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

            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {history.length} points
            </div>
          </div>
        </div>

        <div style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={historicalChartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={theme.grid} strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tick={{ fill: theme.ink }}
                tickFormatter={(value) => formatTime(value)}
                interval="preserveStartEnd"
                minTickGap={28}
              />
              <YAxis
                domain={[35, 85]}
                tick={{ fill: theme.ink }}
                tickFormatter={(v) => `${v} dB`}
              />
              <Tooltip
                labelFormatter={(value) => formatTime(value as number)}
                contentStyle={{
                  background: theme.tooltipBg,
                  border: `1px solid ${theme.border}`,
                  color: theme.ink,
                }}
              />
              <Area
                type="monotone"
                dataKey="dba"
                name="dB(A)"
                stroke={theme.primary}
                fill={theme.primaryFill}
                fillOpacity={0.5}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <footer
        style={{
          textAlign: "center",
          opacity: 0.65,
          fontSize: 12,
          marginTop: 24,
          color: theme.ink,
        }}
      >
        © {new Date().getFullYear()} Nightingale - Live data from PostgreSQL
      </footer>
    </div>
  );
}