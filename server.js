const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const http = require('http');
const socketIo = require('socket.io');

dotenv.config();

const app = express();
const server = http.createServer(app);

// Configuração do CORS para o frontend em produção e ambiente local
const allowedOrigins = [
  'https://uber-clone-eric.vercel.app',
  'http://localhost:3000'
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // Altere para callback(new Error('Bloqueado pelo CORS')) se quiser restringir 100%
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json());

const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST']
  }
});

// Inicializar Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL
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

// WebSocket para localização e estado das corridas em tempo real
io.on('connection', (socket) => {
  console.log('Novo cliente conectado:', socket.id);

  // Entrada em uma sala específica da corrida
  socket.on('join-ride-room', (rideId) => {
    socket.join(`ride_${rideId}`);
    console.log(`Socket ${socket.id} entrou na sala da corrida: ride_${rideId}`);
  });

  // Saída da sala da corrida
  socket.on('leave-ride-room', (rideId) => {
    socket.leave(`ride_${rideId}`);
    console.log(`Socket ${socket.id} saiu da sala: ride_${rideId}`);
  });

  // Entrada dos motoristas na sala geral de ofertas
  socket.on('join-drivers-room', () => {
    socket.join('available_drivers');
    console.log(`Motorista ${socket.id} entrou na sala de motoristas disponíveis.`);
  });

  // Atualização de localização do motorista (enviada para a sala da corrida ativa)
  socket.on('driver-location', (data) => {
    const { rideId, latitude, longitude, driverId } = data;
    if (rideId) {
      io.to(`ride_${rideId}`).emit('update-driver-location', { driverId, latitude, longitude });
    } else {
      socket.broadcast.emit('update-driver-location', data);
    }
  });

  // Usuário solicita uma nova corrida (notifica a sala de motoristas)
  socket.on('request-ride', (data) => {
    console.log('Corrida solicitada:', data);
    io.to('available_drivers').emit('new-ride-request', data);
  });

  // Motorista aceita a corrida
  socket.on('accept-ride', (data) => {
    console.log('Corrida aceita:', data);
    const { rideId } = data;
    if (rideId) {
      socket.join(`ride_${rideId}`);
      io.to(`ride_${rideId}`).emit('ride-accepted', data);
    }
  });

  // Início da corrida
  socket.on('start-ride', (data) => {
    console.log('Corrida iniciada:', data);
    const { rideId } = data;
    if (rideId) {
      io.to(`ride_${rideId}`).emit('ride-started', data);
    }
  });

  // Finalização da corrida
  socket.on('end-ride', (data) => {
    console.log('Corrida finalizada:', data);
    const { rideId } = data;
    if (rideId) {
      io.to(`ride_${rideId}`).emit('ride-ended', data);
    }
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`🔌 WebSocket ativo em ws://localhost:${PORT}`);
});

module.exports = { app, io, db, auth };
