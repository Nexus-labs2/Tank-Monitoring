import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

// Set this to your Render backend URL, e.g. https://tank-monitor-backend.onrender.com
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

const STALE_AFTER_MS = 15000; // if no telemetry for 15s, treat Node 2 as offline
const HISTORY_WINDOW_MS = 5 * 60 * 1000; // use last 5 minutes of readings for fill-rate estimate

function estimateFillTime(history) {
  if (history.length < 2) return null;

  const now = Date.now();
  const recent = history.filter((p) => now - p.t <= HISTORY_WINDOW_MS);
  if (recent.length < 2) return null;

  const first = recent[0];
  const last = recent[recent.length - 1];
  const dtMinutes = (last.t - first.t) / 60000;
  if (dtMinutes <= 0) return null;

  const rate = (last.level - first.level) / dtMinutes; // % per minute

  if (Math.abs(rate) < 0.05) {
    return { status: 'stable', rate };
  }
  if (rate > 0) {
    const minutesToFull = (100 - last.level) / rate;
    return { status: 'filling', rate, minutes: minutesToFull };
  }
  const minutesToEmpty = (last.level - 0) / -rate;
  return { status: 'draining', rate, minutes: minutesToEmpty };
}

function formatMinutes(mins) {
  if (!isFinite(mins) || mins < 0) return '—';
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [telemetry, setTelemetry] = useState({
    level: 0,
    distance: 0,
    pump: false,
    manual: false,
    lastUpdate: null,
  });
  const [history, setHistory] = useState([]);
  const [commandPending, setCommandPending] = useState(false);
  const [now, setNow] = useState(Date.now());

  const socketRef = useRef(null);

  useEffect(() => {
    const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('telemetry', (data) => {
      setTelemetry(data);
      if (typeof data.level === 'number') {
        setHistory((prev) => {
          const next = [...prev, { t: data.lastUpdate || Date.now(), level: data.level }];
          const cutoff = Date.now() - HISTORY_WINDOW_MS;
          return next.filter((p) => p.t >= cutoff);
        });
      }
      setCommandPending(false);
    });

    // Initial state fetch in case the socket connects before the first telemetry event
    fetch(`${BACKEND_URL}/api/state`)
      .then((r) => r.json())
      .then((data) => {
        if (data && data.lastUpdate) setTelemetry(data);
      })
      .catch(() => {});

    return () => socket.disconnect();
  }, []);

  // Tick every second so "last update Xs ago" and staleness stay live
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const dataAgeMs = telemetry.lastUpdate ? now - telemetry.lastUpdate : null;
  const isStale = dataAgeMs === null || dataAgeMs > STALE_AFTER_MS;
  const nodeOnline = connected && !isStale;

  const fillEstimate = useMemo(() => estimateFillTime(history), [history]);

  const level = Math.max(0, Math.min(100, telemetry.level || 0));

  const sendCommand = async (command) => {
    setCommandPending(true);
    try {
      await fetch(`${BACKEND_URL}/api/relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      });
    } catch (e) {
      setCommandPending(false);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Overhead Tank Monitor</h1>
        <div className={`status-pill ${nodeOnline ? 'online' : 'offline'}`}>
          <span className="dot" />
          {nodeOnline ? 'Live' : 'Offline'}
        </div>
      </header>

      <main className="main">
        <section className="tank-section">
          <div className="tank">
            <div className="tank-glass">
              <div
                className="water"
                style={{ height: `${level}%` }}
              >
                <div className="wave wave-back" />
                <div className="wave wave-front" />
              </div>
            </div>
            <div className="tank-percent">{Math.round(level)}%</div>
          </div>

          <div className="metrics">
            <div className="metric-card">
              <span className="metric-label">Distance to water</span>
              <span className="metric-value">{telemetry.distance ?? '—'} mm</span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Fill status</span>
              <span className="metric-value">
                {fillEstimate
                  ? fillEstimate.status === 'stable'
                    ? 'Stable'
                    : fillEstimate.status === 'filling'
                    ? `Filling — full in ${formatMinutes(fillEstimate.minutes)}`
                    : `Draining — empty in ${formatMinutes(fillEstimate.minutes)}`
                  : 'Gathering data…'}
              </span>
            </div>
            <div className="metric-card">
              <span className="metric-label">Last update</span>
              <span className="metric-value">
                {dataAgeMs !== null ? `${Math.round(dataAgeMs / 1000)}s ago` : '—'}
              </span>
            </div>
          </div>
        </section>

        <section className="control-section">
          <h2>Pump Control</h2>
          <div className={`pump-indicator ${telemetry.pump ? 'on' : 'off'}`}>
            <span className="dot" />
            Pump is {telemetry.pump ? 'ON' : 'OFF'}
            {telemetry.manual && <span className="manual-tag">MANUAL</span>}
          </div>

          <div className="button-row">
            <button
              className="btn btn-on"
              disabled={commandPending}
              onClick={() => sendCommand('ON')}
            >
              Turn ON
            </button>
            <button
              className="btn btn-off"
              disabled={commandPending}
              onClick={() => sendCommand('OFF')}
            >
              Turn OFF
            </button>
            <button
              className="btn btn-auto"
              disabled={commandPending}
              onClick={() => sendCommand('AUTO')}
            >
              Back to Auto
            </button>
          </div>
          <p className="hint">
            Manual overrides auto-expire after 15 minutes on the device and revert to
            automatic level-based control.
          </p>
        </section>
      </main>
    </div>
  );
}
