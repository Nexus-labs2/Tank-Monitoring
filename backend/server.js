const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// In-memory state for both tanks - fine for an MVP.
// tankId "1" = roof/overhead tank (has the pump), "2" = underground tank.
let tanks = {
  '1': { tankId: '1', level: 0, distance: 0, pump: false, manual: false, lastUpdate: null },
  '2': { tankId: '2', level: 0, distance: 0, pump: false, manual: false, lastUpdate: null },
};

let pendingCommand = null; // 'ON' | 'OFF' | 'AUTO' | null - always targets tank 1 (the only pump)

// --- Node 2 (master) posts telemetry here for either tank ---
app.post('/api/telemetry', (req, res) => {
  const { tankId, level, distance, pump, manual } = req.body;
  if (tankId !== '1' && tankId !== '2') {
    return res.status(400).json({ error: 'tankId must be "1" or "2"' });
  }

  tanks[tankId] = {
    tankId,
    level: Number(level),
    distance: Number(distance),
    pump: Boolean(pump),
    manual: Boolean(manual),
    lastUpdate: Date.now(),
  };

  io.emit('telemetry', tanks[tankId]);
  res.json({ ok: true });
});

// --- Node 2 polls this for a pending manual relay command (tank 1 only) ---
app.get('/api/command', (req, res) => {
  res.json({ command: pendingCommand });
  pendingCommand = null; // clear once delivered
});

// --- React frontend calls this when the user taps the relay toggle ---
// Relay control only exists on tank 1 (roof tank has the pump).
app.post('/api/relay', (req, res) => {
  const { command } = req.body; // 'ON' | 'OFF' | 'AUTO'
  if (!['ON', 'OFF', 'AUTO'].includes(command)) {
    return res.status(400).json({ error: 'command must be ON, OFF, or AUTO' });
  }
  pendingCommand = command;
  io.emit('relay_command_queued', { command, queuedAt: Date.now() });
  res.json({ ok: true, queued: command });
});

// --- Initial state for the frontend on page load ---
app.get('/api/state', (req, res) => {
  res.json(tanks);
});

app.get('/', (req, res) => {
  res.send('Tank monitor backend is running.');
});

io.on('connection', (socket) => {
  // Send current state of both tanks to a newly connected client
  socket.emit('telemetry', tanks['1']);
  socket.emit('telemetry', tanks['2']);
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));