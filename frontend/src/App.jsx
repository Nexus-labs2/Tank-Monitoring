import React, { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';

// Set this to your Render backend URL, e.g. https://tank-monitoring-jeib.onrender.com
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

const STALE_AFTER_MS = 15000; // if no telemetry for 15s, treat that node as offline
const HISTORY_WINDOW_MS = 5 * 60 * 1000; // last 5 minutes for fill-rate estimate

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

  if (Math.abs(rate) < 0.05) return { status: 'stable', rate };
  if (rate > 0) return { status: 'filling', rate, minutes: (100 - last.level) / rate };
  return { status: 'draining', rate, minutes: last.level / -rate };
}

function formatMinutes(mins) {
  if (!isFinite(mins) || mins < 0) return '—';
  if (mins < 1) return '<1 min';
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

function useTankHistory(level, lastUpdate) {
  const [history, setHistory] = useState([]);
  useEffect(() => {
    if (typeof level !== 'number' || !lastUpdate) return;
    setHistory((prev) => {
      const next = [...prev, { t: lastUpdate, level }];
      const cutoff = Date.now() - HISTORY_WINDOW_MS;
      return next.filter((p) => p.t >= cutoff);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastUpdate]);
  return history;
}

function TankCard({ title, subtitle, tank, now, showPumpControls, onCommand, commandPending }) {
  const dataAgeMs = tank.lastUpdate ? now - tank.lastUpdate : null;
  const isStale = dataAgeMs === null || dataAgeMs > STALE_AFTER_MS;
  const history = useTankHistory(tank.level, tank.lastUpdate);
  const fillEstimate = useMemo(() => estimateFillTime(history), [history]);
  const level = Math.max(0, Math.min(100, tank.level || 0));

  return (
    <section className="tank-section">
      <div className="tank-card-header">
        <div>
          <h2>{title}</h2>
          <p className="tank-subtitle">{subtitle}</p>
        </div>
        <div className={`status-pill ${!isStale ? 'online' : 'offline'}`}>
          <span className="dot" />
          {!isStale ? 'Live' : 'Offline'}
        </div>
      </div>

      <div className="tank-body">
        <div className="tank">
          <div className="tank-glass">
            <div className="water" style={{ height: `${level}%` }}>
              <div className="wave wave-back" />
              <div className="wave wave-front" />
            </div>
          </div>
          <div className="tank-percent">{Math.round(level)}%</div>
        </div>

        <div className="metrics">
          <div className="metric-card">
            <span className="metric-label">Distance to water</span>
            <span className="metric-value">{tank.distance ?? '—'} mm</span>
          </div>
          <div className="metric-card">
            <span className="metric-label">Trend</span>
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
      </div>

      {showPumpControls && (
        <div className="control-section">
          <div className={`pump-indicator ${tank.pump ? 'on' : 'off'}`}>
            <span className="dot" />
            Pump is {tank.pump ? 'ON' : 'OFF'}
            {tank.manual && <span className="manual-tag">MANUAL</span>}
          </div>
          <div className="button-row">
            <button className="btn btn-on" disabled={commandPending} onClick={() => onCommand('ON')}>
              Turn ON
            </button>
            <button className="btn btn-off" disabled={commandPending} onClick={() => onCommand('OFF')}>
              Turn OFF
            </button>
            <button className="btn btn-auto" disabled={commandPending} onClick={() => onCommand('AUTO')}>
              Back to Auto
            </button>
          </div>
          <p className="hint">
            Manual overrides auto-expire after 15 minutes on the device and revert to
            automatic level-based control.
          </p>
        </div>
      )}
    </section>
  );
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [tanks, setTanks] = useState({
    '1': { tankId: '1', level: 0, distance: 0, pump: false, manual: false, lastUpdate: null },
    '2': { tankId: '2', level: 0, distance: 0, pump: false, manual: false, lastUpdate: null },
  });
  const [commandPending, setCommandPending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const socketRef = useRef(null);

  useEffect(() => {
    const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('telemetry', (data) => {
      if (!data || !data.tankId) return;
      setTanks((prev) => ({ ...prev, [data.tankId]: data }));
      setCommandPending(false);
    });

    fetch(`${BACKEND_URL}/api/state`)
      .then((r) => r.json())
      .then((data) => {
        if (data && (data['1'] || data['2'])) setTanks(data);
      })
      .catch(() => {});

    return () => socket.disconnect();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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

  const anyOnline =
    connected &&
    Object.values(tanks).some((t) => t.lastUpdate && now - t.lastUpdate <= STALE_AFTER_MS);

  return (
    <div className="app">
      <header className="header">
        <h1>Tank Monitor</h1>
        <div className={`status-pill ${anyOnline ? 'online' : 'offline'}`}>
          <span className="dot" />
          {anyOnline ? 'System Live' : 'System Offline'}
        </div>
      </header>

      <div className="relationship-note">
        The underground tank feeds the overhead tank — as the underground level drops,
        the overhead tank should rise. Watch both trends together to sanity-check the pump.
      </div>

      <main className="main">
        <TankCard
          title="Overhead Tank"
          subtitle="Roof — Node 1"
          tank={tanks['1']}
          now={now}
          showPumpControls
          onCommand={sendCommand}
          commandPending={commandPending}
        />
        <TankCard
          title="Underground Tank"
          subtitle="Sump — Node 3"
          tank={tanks['2']}
          now={now}
          showPumpControls={false}
        />
      </main>
    </div>
  );
}