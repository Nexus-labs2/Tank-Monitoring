const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// In-memory state - fine for a single-tank MVP.
// Swap for a small DB later if you need history persistence across restarts.
let state = {
  level: 0,
  distance: 0,
  pump: false,
  manual: false,
  lastUpdate: null,
};

let pendingCommand = null; // 'ON' | 'OFF' | 'AUTO' | null

// --- Node 2 posts telemetry here every time it gets a LoRa packet ---
app.post('/api/telemetry', (req, res) => {
  const { level, distance, pump, manual } = req.body;
  state = {
    level: Number(level),
    distance: Number(distance),
    pump: Boolean(pump),
    manual: Boolean(manual),
    lastUpdate: Date.now(),
  };
  io.emit('telemetry', state);
  res.json({ ok: true });
});

// --- Node 2 polls this every few seconds for a pending manual command ---
app.get('/api/command', (req, res) => {
  res.json({ command: pendingCommand });
  pendingCommand = null; // clear once delivered so it isn't sent twice
});

// --- React frontend calls this when the user taps the relay toggle ---
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
  res.json(state);
});

app.get('/', (req, res) => {
  res.send('Tank monitor backend is running.');
});

io.on('connection', (socket) => {
  socket.emit('telemetry', state); // send current state to newly connected client
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Backend listening on port ${PORT}`));
