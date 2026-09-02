const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');

const authRoutes = require('./routes/auth');
const driverRoutes = require('./routes/drivers');
const rideRoutes = require('./routes/rides');
const locationRoutes = require('./routes/location');

dotenv.config();

const app = express();
const server = http.createServer(app);
const allowedOrigins = ['https://uber-clone-eric.vercel.app', 'http://localhost:3000'];
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Bloqueado pelo CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

const io = socketIo(server, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true }
});

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

app.use('/api/auth', authRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/location', locationRoutes);
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

aio.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return next(new Error('Não autenticado'));
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (error) {
    next(new Error('Token inválido ou expirado'));
  }
});

io.on('connection', (socket) => {
  console.log('Cliente Socket.IO conectado:', socket.id, socket.user?.uid);

  socket.on('join-ride-room', async (rideId) => {
    if (!rideId) return;
    try {
      const snap = await db.ref(`rides/${rideId}`).once('value');
      const ride = snap.val();
      if (!ride) return;
      const uid = socket.user.uid;
      if (ride.userId !== uid && ride.driverId !== uid) return;
      socket.join(`ride_${rideId}`);
    } catch (error) {
      console.error('Erro ao entrar na corrida:', error.message);
    }
  });

  socket.on('leave-ride-room', (rideId) => {
    if (rideId) socket.leave(`ride_${rideId}`);
  });

  socket.on('join-drivers-room', async () => {
    try {
      const snap = await db.ref(`users/${socket.user.uid}`).once('value');
      const driver = snap.val();
      if (driver?.userType === 'driver' && driver?.isOnline === true) socket.join('available_drivers');
    } catch (error) {
      console.error('Erro ao entrar na sala de motoristas:', error.message);
    }
  });

  socket.on('driver-location', async (data = {}) => {
    const { rideId } = data;
    const latitude = Number(data.latitude ?? data.lat);
    const longitude = Number(data.longitude ?? data.lng);
    const driverId = socket.user.uid;
    if (!rideId || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    try {
      const snap = await db.ref(`rides/${rideId}`).once('value');
      const ride = snap.val();
      if (!ride || ride.driverId !== driverId) return;
      const location = { latitude, longitude, lat: latitude, lng: longitude, timestamp: Date.now() };
      await db.ref(`locations/${driverId}`).set(location);
      await db.ref(`users/${driverId}`).update({ currentLocation: { lat: latitude, lng: longitude }, lastLocationUpdate: new Date().toISOString() });
      io.to(`ride_${rideId}`).emit('update-driver-location', { driverId, ...location });
    } catch (error) {
      console.error('Erro na localização:', error.message);
    }
  });

  socket.on('request-ride', async (data = {}) => {
    if (!data.rideId) return;
    try {
      const snap = await db.ref(`rides/${data.rideId}`).once('value');
      const ride = snap.val();
      if (!ride || ride.userId !== socket.user.uid || ride.status !== 'SEARCHING') return;
      io.to('available_drivers').emit('new-ride-request', { rideId: data.rideId, passengerId: socket.user.uid, origin: ride.origin, destination: ride.destination, price: ride.price, distance: ride.distance });
    } catch (error) {
      console.error('Erro ao divulgar corrida:', error.message);
    }
  });

  socket.on('accept-ride', async (data = {}) => {
    if (!data.rideId) return;
    try {
      const snap = await db.ref(`rides/${data.rideId}`).once('value');
      const ride = snap.val();
      // A aceitação é persistida pela rota HTTP; aqui apenas notificamos a sala.
      if (!ride || ride.driverId !== socket.user.uid || ride.status !== 'ACCEPTED') return;
      socket.join(`ride_${data.rideId}`);
      io.to(`ride_${data.rideId}`).emit('ride-accepted', { rideId: data.rideId, driverId: socket.user.uid });
    } catch (error) {
      console.error('Erro ao notificar aceitação:', error.message);
    }
  });

  socket.on('start-ride', async (data = {}) => {
    if (!data.rideId) return;
    const snap = await db.ref(`rides/${data.rideId}`).once('value');
    const ride = snap.val();
    if (!ride || ride.driverId !== socket.user.uid || ride.status !== 'IN_PROGRESS') return;
    io.to(`ride_${data.rideId}`).emit('ride-started', { rideId: data.rideId });
  });

  socket.on('end-ride', async (data = {}) => {
    if (!data.rideId) return;
    const snap = await db.ref(`rides/${data.rideId}`).once('value');
    const ride = snap.val();
    if (!ride || ride.driverId !== socket.user.uid || ride.status !== 'COMPLETED') return;
    io.to(`ride_${data.rideId}`).emit('ride-ended', { rideId: data.rideId });
  });

  socket.on('disconnect', () => console.log('Cliente Socket.IO desconectado:', socket.id));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Socket.IO ativo na porta ${PORT}`);
});

module.exports = { app, io, db, auth };
