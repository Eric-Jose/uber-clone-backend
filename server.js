const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');
const { authenticate } = require('./middleware/auth');

dotenv.config();

const requiredFirebaseEnv = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_DATABASE_URL'];
const missingFirebaseEnv = requiredFirebaseEnv.filter((key) => !process.env[key]);
if (missingFirebaseEnv.length) throw new Error(`Firebase Admin não pode ser inicializado: variáveis ausentes: ${missingFirebaseEnv.join(', ')}`);

if (!admin.apps.length) {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  admin.initializeApp({
    credential: admin.credential.cert({ projectId: process.env.FIREBASE_PROJECT_ID, privateKey, clientEmail: process.env.FIREBASE_CLIENT_EMAIL }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined
  });
}

const db = admin.database();
const auth = admin.auth();
const authRoutes = require('./routes/auth');
const firebaseSessionRoutes = require('./routes/firebase-session');
const passwordResetRoutes = require('./routes/password-reset');
const driverRoutes = require('./routes/drivers');
const rideRoutes = require('./routes/rides');
const pendingRideRoutes = require('./routes/pending-rides');
const locationRoutes = require('./routes/location');
const ratingRoutes = require('./routes/ratings');
const adminStatsRoutes = require('./routes/admin-stats');

const app = express();
const server = http.createServer(app);
const allowedOrigins = ['https://uber-clone-web.vercel.app', 'https://uber-clone-web-eric-jose.vercel.app', 'https://uber-clone-web-git-main-eric-jose.vercel.app', 'https://uber-clone-eric.vercel.app', 'http://localhost:3000'];
const isAllowedOrigin = (origin) => !origin || allowedOrigins.includes(origin) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin);
const corsOptions = { origin: (origin, callback) => isAllowedOrigin(origin) ? callback(null, true) : callback(new Error('Bloqueado pelo CORS')), methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], credentials: true };
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

const io = socketIo(server, { cors: { origin: true, methods: ['GET', 'POST'], credentials: true } });
rideRoutes.setSocketIo(io);
app.use('/api/auth', authRoutes);
app.use('/api/auth/firebase-session', firebaseSessionRoutes);
app.use('/api/auth/password-reset', passwordResetRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/rides/pending', pendingRideRoutes);

// Compatibilidade explícita para clientes que usam o histórico no painel.
// Esta rota fica antes do router de corridas e evita regressões caso a rota
// seja removida em alguma versão do módulo principal de rides.
app.get('/api/rides/history', authenticate, async (req, res) => {
  try {
    const uid = req.user.uid;
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 30;
    const user = (await db.ref(`users/${uid}`).get()).val();
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const snapshot = await db.ref('rides').get();
    const rides = [];
    snapshot.forEach((child) => {
      const ride = child.val();
      if (!ride) return;
      const matches = user.userType === 'driver'
        ? String(ride.driverId || '') === String(uid)
        : String(ride.userId || '') === String(uid);
      if (matches) rides.push(ride);
    });
    rides.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
    return res.json({ success: true, rides: rides.slice(0, limit) });
  } catch (error) {
    console.error('Erro ao buscar histórico de corridas:', error.message);
    return res.status(500).json({ error: 'Erro ao buscar histórico de corridas.' });
  }
});

app.use('/api/rides', rideRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/ratings', ratingRoutes);
app.use('/api/admin-stats', adminStatsRoutes);

// Railway healthcheck uses /health; keep /api/health for compatibility with existing clients.
const healthHandler = (req, res) => res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);
app.use((error, req, res, next) => { console.error('Erro não tratado na API:', error?.stack || error); if (res.headersSent) return next(error); return res.status(500).json({ error: 'Erro interno do servidor.' }); });

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) return next(new Error('Não autenticado'));
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (error) { next(new Error('Token inválido ou expirado')); }
});

function distanceKm(a, b) {
  const lat1 = Number(a?.lat ?? a?.latitude), lon1 = Number(a?.lng ?? a?.longitude), lat2 = Number(b?.lat ?? b?.latitude), lon2 = Number(b?.lng ?? b?.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

async function findNearestDrivers(origin) {
  const [usersSnapshot, locationsSnapshot] = await Promise.all([db.ref('users').get(), db.ref('locations').get()]);
  const users = usersSnapshot.val() || {}, locations = locationsSnapshot.val() || {}, originLocation = origin?.location || origin?.currentLocation || origin;
  const drivers = [];
  for (const [uid, user] of Object.entries(users)) {
    if (user?.userType !== 'driver' || user?.driverApprovalStatus !== 'approved' || user?.isOnline !== true) continue;
    const location = user.currentLocation || locations[uid], distance = distanceKm(originLocation, location);
    if (Number.isFinite(distance)) drivers.push({ uid, distance });
  }
  return drivers.sort((a, b) => a.distance - b.distance);
}

async function saveDriverLocation(driverId, latitude, longitude) {
  const location = { latitude, longitude, lat: latitude, lng: longitude, timestamp: Date.now() };
  await db.ref(`locations/${driverId}`).set(location);
  await db.ref(`users/${driverId}`).update({ currentLocation: { lat: latitude, lng: longitude }, lastLocationUpdate: new Date().toISOString() });
  return location;
}

io.on('connection', async (socket) => {
  console.log('Cliente Socket.IO conectado:', socket.id, socket.user?.uid);
  socket.driverReady = false;
  socket.driverRoomLoading = false;

  socket.on('join-ride-room', async (rideId) => {
    if (!rideId) return;
    try {
      const snap = await db.ref(`rides/${rideId}`).once('value'), ride = snap.val(), uid = socket.user.uid;
      if (!ride || (ride.userId !== uid && ride.driverId !== uid)) return;
      socket.join(`ride_${rideId}`);
    } catch (error) { console.error('Erro ao entrar na corrida:', error.message); }
  });
  socket.on('leave-ride-room', (rideId) => { if (rideId) socket.leave(`ride_${rideId}`); });

  socket.on('join-drivers-room', async () => {
    if (socket.driverReady || socket.driverRoomLoading) return;
    socket.driverRoomLoading = true;
    try {
      const snap = await db.ref(`users/${socket.user.uid}`).once('value'), driver = snap.val();
      const approvedOnline = driver?.userType === 'driver' && driver?.driverApprovalStatus === 'approved' && driver?.isOnline === true;
      if (approvedOnline) {
        socket.join('available_drivers');
        socket.join(`driver_${socket.user.uid}`);
        socket.driverReady = true;
      }
    } catch (error) { console.error('Erro ao entrar na sala de motoristas:', error.message); }
    finally { socket.driverRoomLoading = false; }
  });

  socket.on('driver-presence-location', async (data = {}) => {
    const latitude = Number(data.latitude ?? data.lat), longitude = Number(data.longitude ?? data.lng), driverId = socket.user.uid;
    if (!socket.driverReady || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;
    try { await saveDriverLocation(driverId, latitude, longitude); } catch (error) { console.error('Erro na localização do motorista online:', error.message); }
  });

  socket.on('driver-location', async (data = {}) => {
    const { rideId } = data, latitude = Number(data.latitude ?? data.lat), longitude = Number(data.longitude ?? data.lng), driverId = socket.user.uid;
    if (!rideId || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;
    try {
      const snap = await db.ref(`rides/${rideId}`).once('value'), ride = snap.val();
      if (!ride || ride.driverId !== driverId || !['ACCEPTED', 'IN_PROGRESS'].includes(ride.status)) return;
      const location = await saveDriverLocation(driverId, latitude, longitude);
      io.to(`ride_${rideId}`).emit('update-driver-location', { driverId, ...location });
    } catch (error) { console.error('Erro na localização:', error.message); }
  });

  socket.on('passenger-location', async (data = {}) => {
    const rideId = data.rideId, passengerId = socket.user.uid;
    const latitude = Number(data.latitude ?? data.lat), longitude = Number(data.longitude ?? data.lng);
    if (!rideId || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;
    try {
      const ref = db.ref(`rides/${rideId}`), snap = await ref.once('value'), ride = snap.val();
      if (!ride || ride.userId !== passengerId || !['SEARCHING', 'ACCEPTED', 'IN_PROGRESS'].includes(ride.status)) return;
      const location = { lat: latitude, lng: longitude, timestamp: Date.now() };
      await ref.update({ passengerLocation: location, 'origin/location': { lat: latitude, lng: longitude } });
      if (ride.driverId) io.to(`driver_${ride.driverId}`).emit('passenger-location-update', { rideId, passengerId, location });
      io.to(`ride_${rideId}`).emit('passenger-location-update', { rideId, passengerId, location });
    } catch (error) { console.error('Erro na localização do passageiro:', error.message); }
  });

  socket.on('request-ride', async (data = {}) => {
    if (!data.rideId) return;
    try {
      const rideRef = db.ref(`rides/${data.rideId}`), snap = await rideRef.once('value'), ride = snap.val();
      if (!ride || ride.userId !== socket.user.uid || ride.status !== 'SEARCHING') return;
      const nearestDrivers = await findNearestDrivers(ride.origin), request = { rideId: data.rideId, passengerId: socket.user.uid, passengerName: ride.passengerName || 'Passageiro', passengerProfilePhoto: ride.passengerProfilePhoto || null, origin: ride.origin, destination: ride.destination, passengerLocation: ride.passengerLocation || ride.origin?.location || null, price: ride.price, distance: ride.distance };
      const eligibleDrivers = nearestDrivers.filter((driver) => driver.distance <= 25);
      let offered = false;
      for (const driver of eligibleDrivers.slice(0, 10)) {
        const current = (await rideRef.once('value')).val();
        if (!current || current.status !== 'SEARCHING' || current.driverId) break;
        io.to(`driver_${driver.uid}`).emit('new-ride-request', { ...request, estimatedDistanceKm: Number(driver.distance.toFixed(2)), dispatchRadiusKm: 25, source: 'socket-dispatch' });
        offered = true;
        await new Promise(resolve => setTimeout(resolve, 8000));
        const afterOffer = (await rideRef.once('value')).val();
        if (!afterOffer || afterOffer.status !== 'SEARCHING' || afterOffer.driverId) break;
      }
      if (!offered) console.log('Nenhum motorista elegível recebeu a oferta da corrida:', data.rideId);
    } catch (error) { console.error('Erro ao encontrar motorista:', error.message); }
  });

  socket.on('accept-ride', async (data = {}) => {
    if (!data.rideId) return;
    try {
      const snap = await db.ref(`rides/${data.rideId}`).once('value'), ride = snap.val();
      if (!ride || ride.driverId !== socket.user.uid || ride.status !== 'ACCEPTED') return;
      socket.join(`ride_${data.rideId}`);
      io.to(`ride_${data.rideId}`).emit('ride-accepted', { rideId: data.rideId, driverId: socket.user.uid, ride });
    } catch (error) { console.error('Erro ao notificar aceitação:', error.message); }
  });
  socket.on('ride-cancelled', async (data = {}) => {
    if (!data.rideId) return;
    try {
      const snap = await db.ref(`rides/${data.rideId}`).once('value'), ride = snap.val(), uid = socket.user.uid;
      if (!ride || (ride.userId !== uid && ride.driverId !== uid) || ride.status !== 'CANCELLED') return;
      io.to(`ride_${data.rideId}`).emit('ride-cancelled', { rideId: data.rideId, cancelledBy: ride.cancelledBy || uid, cancellationReason: ride.cancellationReason || null });
    } catch (error) { console.error('Erro ao notificar cancelamento:', error.message); }
  });
  socket.on('start-ride', async (data = {}) => {
    if (!data.rideId) return;
    try {
      const snap = await db.ref(`rides/${data.rideId}`).once('value'), ride = snap.val();
      if (!ride || ride.driverId !== socket.user.uid || ride.status !== 'IN_PROGRESS') return;
      io.to(`ride_${data.rideId}`).emit('ride-started', { rideId: data.rideId, ride });
    } catch (error) { console.error('Erro ao iniciar corrida:', error.message); }
  });
  socket.on('end-ride', async (data = {}) => {
    if (!data.rideId) return;
    try {
      const snap = await db.ref(`rides/${data.rideId}`).once('value'), ride = snap.val();
      if (!ride || ride.driverId !== socket.user.uid || ride.status !== 'COMPLETED') return;
      io.to(`ride_${data.rideId}`).emit('ride-ended', { rideId: data.rideId, ride });
    } catch (error) { console.error('Erro ao finalizar corrida:', error.message); }
  });
  socket.on('disconnect', () => console.log('Cliente Socket.IO desconectado:', socket.id));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => { console.log(`Servidor rodando na porta ${PORT}`); console.log(`Socket.IO ativo na porta ${PORT}`); });
module.exports = { app, io, db, auth };
