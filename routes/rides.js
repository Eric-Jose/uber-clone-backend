const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { authenticate } = require('../middleware/auth');

const db = admin.database();
let io = null;
const VALID_STATUSES = ['SEARCHING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const ACTIVE_STATUSES = ['SEARCHING', 'ACCEPTED', 'IN_PROGRESS'];

router.setSocketIo = (socketIoInstance) => { io = socketIoInstance; };
router.use(authenticate);

function emitToRide(rideId, event, payload) {
  if (io && rideId) io.to(`ride_${rideId}`).emit(event, payload);
}

function normalizeLocation(value) {
  const source = value?.location || value?.currentLocation || value || {};
  const lat = Number(source.lat ?? source.latitude);
  const lng = Number(source.lng ?? source.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

router.post('/request', async (req, res) => {
  let step = 'start';
  try {
    const { origin, destination, price, distance } = req.body || {};
    const userId = req.user.uid;
    step = 'validate-payload';
    if (!origin || !destination) return res.status(400).json({ error: 'Origem e destino são obrigatórios.' });
    const originLocation = normalizeLocation(origin);
    const destinationLocation = normalizeLocation(destination);
    if (!originLocation || !destinationLocation) return res.status(400).json({ error: 'A localização de origem e destino é inválida. Escolha o destino novamente.' });
    step = 'load-user';
    const userSnapshot = await db.ref(`users/${userId}`).get();
    const user = userSnapshot.val();
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (user.userType !== 'passenger') return res.status(403).json({ error: 'Somente passageiros podem solicitar corridas.' });
    step = 'check-active-rides';
    const ridesSnapshot = await db.ref('rides').get();
    let activeRide = null;
    ridesSnapshot.forEach(child => {
      const ride = child.val();
      if (ride && ride.userId === userId && ACTIVE_STATUSES.includes(ride.status)) activeRide = ride;
    });
    if (activeRide) return res.status(409).json({ error: 'Você já possui uma corrida em andamento.', ride: activeRide });
    const safePrice = Number(price);
    const safeDistance = Number(distance);
    if (!Number.isFinite(safePrice) || safePrice < 0 || !Number.isFinite(safeDistance) || safeDistance < 0) return res.status(400).json({ error: 'Dados de preço ou distância inválidos.' });
    step = 'create-ride';
    const newRideRef = db.ref('rides').push();
    const rideData = {
      id: newRideRef.key,
      userId,
      driverId: null,
      passengerName: user.name || user.email || 'Passageiro',
      passengerProfilePhoto: user.profilePhoto || null,
      origin: { address: String(origin.address || origin.display_name || 'Minha localização atual'), location: originLocation },
      destination: { address: String(destination.address || destination.display_name || 'Destino'), location: destinationLocation },
      price: safePrice,
      distance: safeDistance,
      status: 'SEARCHING',
      createdAt: admin.database.ServerValue.TIMESTAMP
    };
    await newRideRef.set(rideData);
    step = 'success';
    return res.status(201).json({ success: true, ride: rideData });
  } catch (error) {
    console.error('Erro ao solicitar corrida:', { step, message: error?.message, code: error?.code, stack: error?.stack });
    return res.status(500).json({ error: 'Erro interno ao criar corrida.', step, code: error?.code || 'UNKNOWN', details: error?.message || 'Erro desconhecido' });
  }
});

router.post('/accept', async (req, res) => {
  try {
    const { rideId } = req.body;
    const driverId = req.user.uid;
    if (!rideId) return res.status(400).json({ error: 'ID da corrida é obrigatório.' });
    const driverSnapshot = await db.ref(`users/${driverId}`).get();
    const driver = driverSnapshot.val();
    if (!driver || driver.userType !== 'driver') return res.status(403).json({ error: 'Somente motoristas podem aceitar corridas.' });
    if (driver.driverApprovalStatus !== 'approved') return res.status(403).json({ error: 'Motorista ainda não foi aprovado.' });
    if (!driver.isOnline) return res.status(409).json({ error: 'Motorista está offline.' });
    const activeRidesSnapshot = await db.ref('rides').orderByChild('driverId').equalTo(driverId).get();
    let activeDriverRide = null;
    activeRidesSnapshot.forEach(child => { const ride = child.val(); if (ACTIVE_STATUSES.includes(ride.status)) activeDriverRide = ride; });
    if (activeDriverRide) return res.status(409).json({ error: 'Você já possui uma corrida em andamento. Finalize ou cancele a corrida atual antes de aceitar outra.', ride: activeDriverRide });
    const rideRef = db.ref(`rides/${rideId}`);
    const result = await rideRef.transaction((ride) => {
      if (!ride || ride.status !== 'SEARCHING' || ride.driverId) return;
      ride.driverId = driverId;
      ride.driverName = driver.name || driver.email || 'Motorista';
      ride.driverProfilePhoto = driver.profilePhoto || null;
      ride.status = 'ACCEPTED';
      ride.acceptedAt = admin.database.ServerValue.TIMESTAMP;
      return ride;
    });
    if (!result.committed) return res.status(409).json({ error: 'Corrida já foi aceita ou não existe.' });
    const acceptedRide = result.snapshot.val();
    emitToRide(rideId, 'ride-accepted', { rideId, driverId, ride: acceptedRide });
    return res.json({ success: true, ride: acceptedRide });
  } catch (error) { console.error('Erro ao aceitar corrida:', error); return res.status(500).json({ error: 'Erro ao aceitar corrida.' }); }
});

async function updateRideStatus(req, res) {
  try {
    const rideId = req.params.rideId || req.body.rideId;
    const { status, cancellationReason } = req.body;
    if (!rideId || !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Status de corrida inválido.' });
    const rideRef = db.ref(`rides/${rideId}`);
    const snapshot = await rideRef.get();
    const ride = snapshot.val();
    if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' });
    const uid = req.user.uid;
    if (ride.userId !== uid && ride.driverId !== uid) return res.status(403).json({ error: 'Você não pertence a esta corrida.' });
    const allowedTransitions = { SEARCHING: ['CANCELLED'], ACCEPTED: ['IN_PROGRESS', 'CANCELLED'], IN_PROGRESS: ['COMPLETED', 'CANCELLED'], COMPLETED: [], CANCELLED: [] };
    if (!allowedTransitions[ride.status]?.includes(status)) return res.status(409).json({ error: `Não é possível mudar de ${ride.status} para ${status}.` });
    const passengerCanCancel = status === 'CANCELLED' && ride.userId === uid;
    const driverCanChange = ride.driverId === uid && ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(status);
    if (!passengerCanCancel && !driverCanChange) return res.status(403).json({ error: 'Você não tem permissão para essa mudança.' });
    const update = { status, updatedAt: admin.database.ServerValue.TIMESTAMP };
    if (status === 'CANCELLED') {
      update.cancelledBy = uid;
      update.cancelledAt = admin.database.ServerValue.TIMESTAMP;
      if (cancellationReason) update.cancellationReason = String(cancellationReason).slice(0, 200);
    }
    await rideRef.update(update);
    const updatedSnapshot = await rideRef.get();
    const updatedRide = updatedSnapshot.val();
    const eventPayload = { rideId, ride: updatedRide };
    if (status === 'IN_PROGRESS') emitToRide(rideId, 'ride-started', eventPayload);
    if (status === 'COMPLETED') emitToRide(rideId, 'ride-ended', eventPayload);
    if (status === 'CANCELLED') emitToRide(rideId, 'ride-cancelled', { ...eventPayload, cancelledBy: uid, cancellationReason: updatedRide?.cancellationReason || null });
    return res.json({ success: true, status, ride: updatedRide });
  } catch (error) { console.error('Erro ao atualizar status:', error); return res.status(500).json({ error: 'Erro ao atualizar status da corrida.' }); }
}

router.patch('/:rideId/status', updateRideStatus);
router.patch('/status', updateRideStatus);

router.get('/history', async (req, res) => {
  try {
    const uid = req.user.uid;
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 30;
    const userSnapshot = await db.ref(`users/${uid}`).get();
    const user = userSnapshot.val();
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    const field = user.userType === 'driver' ? 'driverId' : 'userId';
    const snapshot = await db.ref('rides').orderByChild(field).equalTo(uid).get();
    const rides = [];
    snapshot.forEach(child => rides.push(child.val()));
    rides.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));
    return res.json({ success: true, rides: rides.slice(0, limit) });
  } catch (error) { console.error('Erro ao buscar histórico:', error); return res.status(500).json({ error: 'Erro interno ao buscar histórico de corridas.' }); }
});

router.get('/:rideId', async (req, res) => {
  try {
    const snapshot = await db.ref(`rides/${req.params.rideId}`).get();
    const ride = snapshot.val();
    if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' });
    if (ride.userId !== req.user.uid && ride.driverId !== req.user.uid) return res.status(403).json({ error: 'Acesso negado.' });
    return res.json({ success: true, ride });
  } catch (error) { console.error('Erro ao buscar corrida:', error); return res.status(500).json({ error: 'Erro interno ao buscar corrida.' }); }
});

module.exports = router;
