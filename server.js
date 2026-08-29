const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const http = require('http');
const socketIo = require('socket.io');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Inicializar Firebase
if (!admin.apps.length) {
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID,
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
  });
}

const db = admin.database();
const auth = admin.auth();

// Importar rotas
const authRoutes = require('./routes/auth');
const driverRoutes = require('./routes/drivers');
const rideRoutes = require('./routes/rides');
const locationRoutes = require('./routes/location');

// Usar rotas
app.use('/api/auth', authRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/location', locationRoutes);

// Rota de teste
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running!', timestamp: new Date() });
});

// WebSocket para localização em tempo real
io.on('connection', (socket) => {
  console.log('Novo usuário conectado:', socket.id);

  // Motorista envia localização
  socket.on('driver-location', (data) => {
    console.log('Localização do motorista:', data);
    io.emit('update-driver-location', data);
  });

  // Usuário solicita corrida
  socket.on('request-ride', (data) => {
    console.log('Corrida solicitada:', data);
    io.emit('new-ride-request', data);
  });

  // Motorista aceita corrida
  socket.on('accept-ride', (data) => {
    console.log('Corrida aceita:', data);
    io.emit('ride-accepted', data);
  });

  // Corrida iniciada
  socket.on('start-ride', (data) => {
    console.log('Corrida iniciada:', data);
    io.emit('ride-started', data);
  });

  // Corrida finalizada
  socket.on('end-ride', (data) => {
    console.log('Corrida finalizada:', data);
    io.emit('ride-ended', data);
  });

  socket.on('disconnect', () => {
    console.log('Usuário desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔌 WebSocket ativo em ws://localhost:${PORT}`);
});

module.exports = { app, io, db, auth };
