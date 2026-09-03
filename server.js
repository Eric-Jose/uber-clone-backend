const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');

dotenv.config();

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
const authRoutes = require('./routes/auth');
const passwordResetRoutes = require('./routes/password-reset');
const driverRoutes = require('./routes/drivers');
const rideRoutes = require('./routes/rides');
const locationRoutes = require('./routes/location');
const ratingRoutes = require('./routes/ratings');

const app = express();
const server = http.createServer(app);

const allowedOrigins = [
  'https://uber-clone-web.vercel.app',
  'https://uber-clone-web-eric-jose.vercel.app',
  'https://uber-clone-web-git-main-eric-jose.vercel.app',
  'https://uber-clone-eric.vercel.app',
  'http://localhost:3000'
];

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  // Permite deployments/aliases HTTPS da Vercel sem abrir o CORS para outros hosts.
  return /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Bloqueado pelo CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
const io = socketIo(server, { cors: { origin: isAllowedOrigin, methods: ['GET', 'POST'], credentials: true } });
app.use('/api/auth', authRoutes);
app.use('/api/auth/password-reset', passwordResetRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/ratings', ratingRoutes);
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return next(new Error('Não autenticado'));
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (error) { next(new Error('Token inválido ou expirado')); }
});

function distanceKm(a, b) {
  const lat1 = Number(a?.lat ?? a?.latitude);
  const lon1 = Number(a?.lng ?? a?.longitude);
  const lat2 = Number(b?.lat ?? b?.latitude);
  const lon2 = Number(b?.lng ?? b?.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

async function findNearestDrivers(origin) {
  const usersSnapshot = await db.ref('users').get();
  const locationsSnapshot = await db.ref('locations').get();
  const users = usersSnapshot.val() || {};
  const locations = locationsSnapshot.val() || {};
  const originLocation = origin?.location || origin?.currentLocation || origin;
  const drivers = [];
  for (const [uid, user] of Object.entries(users)) {
    if (user?.userType !== 'driver' || user?.driverApprovalStatus !== 'approved' || user?.isOnline !== true) continue;
    const location = user.currentLocation || locations[uid];
    const distance = distanceKm(originLocation, location);
    if (Number.isFinite(distance)) drivers.push({ uid, distance });
  }
  return drivers.sort((a, b) => a.distance - b.distance);
}

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
    } catch (error) { console.error('Erro ao entrar na corrida:', error.message); }
  });
  socket.on('leave-ride-room', (rideId) => { if (rideId) socket.leave(`ride_${rideId}`); });
  socket.on('join-drivers-room', async () => {
    try {
      const snap = await db.ref(`users/${socket.user.uid}`).once('value');
      const driver = snap.val();
      if (driver?.userType === 'driver' && driver?.driverApprovalStatus === 'approved' && driver?.isOnline === true) {
        socket.join('available_drivers');
        socket.join(`driver_${socket.user.uid}`);
      }
    } catch (error) { console.error('Erro ao entrar na sala de motoristas:', error.message); }
  });
  socket.on('driver-location', async (data = {}) => {
    const { rideId } = data;
    const latitude = Number(data.latitude ?? data.lat);
    const longitude = Number(data.longitude ?? data.lng);
    const driverId = socket.user.uid;
    if (!rideId || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;
    try {
      const snap = await db.ref(`rides/${rideId}`).once('value');
      const ride = snap.val();
      if (!ride || ride.driverId !== driverId || !['ACCEPTED', 'IN_PROGRESS'].includes(ride.status)) return;
      const location = { latitude, longitude, lat: latitude, lng: longitude, timestamp: Date.now() };
      await db.ref(`locations/${driverId}`).set(location);
      await db.ref(`users/${driverId}`).update({ currentLocation: { lat: latitude, lng: longitude }, lastLocationUpdate: new Date().toISOString() });
      io.to(`ride_${rideId}`).emit('update-driver-location', { driverId, ...location });
    } catch (error) { console.error('Erro na localização:', error.message); }
  });
  socket.on('request-ride', async (data = {}) => {
    if (!data.rideId) return;
    try {
      const rideRef = db.ref(`rides/${data.rideId}`);
      const snap = await rideRef.once('value');
      const ride = snap.val();
      if (!ride || ride.userId !== socket.user.uid || ride.status !== 'SEARCHING') return;
      const nearestDrivers = await findNearestDrivers(ride.origin);
      const request = { rideId: data.rideId, passengerId: socket.user.uid, origin: ride.origin, destination: ride.destination, price: ride.price, distance: ride.distance };
      if (!nearestDrivers.length) { io.to('available_drivers').emit('new-ride-request', request); return; }
      let offered = false;
      for (const driver of nearestDrivers) {
        const current = (await rideRef.once('value')).val();
        if (!current || current.status !== 'SEARCHING' || current.driverId) break;
        io.to(`driver_${driver.uid}`).emit('new-ride-request', { ...request, estimatedDistanceKm: Number(driver.distance.toFixed(2)) });
        offered = true;
        await new Promise(resolve => setTimeout(resolve, 8000));
        const afterOffer = (await rideRef.once('value')).val();
        if (!afterOffer || afterOffer.status !== 'SEARCHING' || afterOffer.driverId) break;
      }
      if (!offered) io.to('available_drivers').emit('new-ride-request', request);
    } catch (error) { console.error('Erro ao encontrar motorista:', error.message); }
  });
  socket.on('accept-ride', async (data = {}) => {
    if (!data.rideId) return;
    try {
      const snap = await db.ref(`rides/${data.rideId}`).once('value');
      const ride = snap.val();
      if (!ride || ride.driverId !== socket.user.uid || ride.status !== 'ACCEPTED') return;
      socket.join(`ride_${data.rideId}`);
      io.to(`ride_${data.rideId}`).emit('ride-accepted', { rideId: data.rideId, driverId: socket.user.uid });
    } catch (error) { console.error('Erro ao notificar aceitação:', error.message); }
  });
  socket.on('ride-cancelled', async (data = {}) => {
    if (!data.rideId) return;
    try {
      const snap = await db.ref(`rides/${data.rideId}`).once('value');
      const ride = snap.val();
      const uid = socket.user.uid;
      if (!ride || (ride.userId !== uid && ride.driverId !== uid) || ride.status !== 'CANCELLED') return;
      io.to(`ride_${data.rideId}`).emit('ride-cancelled', { rideId: data.rideId, cancelledBy: ride.cancelledBy || uid, cancellationReason: ride.cancellationReason || null });
    } catch (error) { console.error('Erro ao notificar cancelamento:', error.message); }
  });
  socket.on('start-ride', async (data = {}) => {
    if (!data.rideId) return;
    try {
      const snap = await db.ref(`rides/${data.rideId}`).once('value');
      const ride = snap.val();
      if (!ride || ride.driverId !== socket.user.uid || ride.status !== 'IN_PROGRESS') return;
      io.to(`ride_${data.rideId}`).emit('ride-started', { rideId: data.rideId });
    } catch (error) { console.error('Erro ao iniciar corrida:', error.message); }
  });
  socket.on('end-ride', async (data = {}) => {
    if (!data.rideId) return;
    try {
      const snap = await db.ref(`rides/${data.rideId}`).once('value');
      const ride = snap.val();
      if (!ride || ride.driverId !== socket.user.uid || ride.status !== 'COMPLETED') return;
      io.to(`ride_${data.rideId}`).emit('ride-ended', { rideId: data.rideId });
    } catch (error) { console.error('Erro ao finalizar corrida:', error.message); }
  });
  socket.on('disconnect', () => console.log('Cliente Socket.IO desconectado:', socket.id));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Socket.IO ativo na porta ${PORT}`);
});

module.exports = { app, io, db, auth };
