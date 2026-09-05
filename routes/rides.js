const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { authenticate } = require('../middleware/auth');

const db = admin.database();
let io = null;
const dispatchingRideIds = new Set();
const acceptingRideIds = new Set();

const VALID_STATUSES = ['SEARCHING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const ACTIVE_STATUSES = ['SEARCHING', 'ACCEPTED', 'IN_PROGRESS'];
const DISPATCH_RADIUS_KM = Math.max(1, Number(process.env.DISPATCH_RADIUS_KM) || 25);
const DISPATCH_RADIUS_EXTENDED_KM = Math.max(DISPATCH_RADIUS_KM, Number(process.env.DISPATCH_RADIUS_EXTENDED_KM) || 50);
const DISPATCH_RADIUS_LONG_KM = Math.max(DISPATCH_RADIUS_EXTENDED_KM, Number(process.env.DISPATCH_RADIUS_LONG_KM) || 100);
const ARRIVAL_RADIUS_KM = 0.15;

router.setSocketIo = (socketIo) => { io = socketIo; };
function emitToRide(id, event, payload) { if (io && id) io.to(`ride_${id}`).emit(event, payload); }
function normalizeLocation(value) { const source = value?.location || value?.currentLocation || value || {}; const lat = Number(source.lat ?? source.latitude), lng = Number(source.lng ?? source.longitude); if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null; return { lat, lng }; }
function distanceKm(a, b) { const lat1 = Number(a?.lat ?? a?.latitude), lon1 = Number(a?.lng ?? a?.longitude), lat2 = Number(b?.lat ?? b?.latitude), lon2 = Number(b?.lng ?? b?.longitude); if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity; const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180; const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2; return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); }
function dispatchRadiusKm(ageMs) { if (ageMs < 60 * 1000) return DISPATCH_RADIUS_KM; if (ageMs < 5 * 60 * 1000) return DISPATCH_RADIUS_EXTENDED_KM; return DISPATCH_RADIUS_LONG_KM; }
async function findEligibleDrivers(origin, radiusKm = DISPATCH_RADIUS_KM) { const [usersSnapshot, locationsSnapshot] = await Promise.all([db.ref('users').get(), db.ref('locations').get()]); const users = usersSnapshot.val() || {}, locations = locationsSnapshot.val() || {}, originLocation = normalizeLocation(origin), drivers = []; for (const [uid, user] of Object.entries(users)) { if (user?.userType !== 'driver' || user?.driverApprovalStatus !== 'approved' || user?.isOnline !== true) continue; const location = normalizeLocation(user.currentLocation || locations[uid]), distance = distanceKm(originLocation, location); if (Number.isFinite(distance) && distance <= radiusKm) drivers.push({ uid, distance }); } return drivers.sort((a, b) => a.distance - b.distance); }
async function dispatchRide(ride) { if (!io || !ride?.id || ride.status !== 'SEARCHING') return { sent: 0, eligible: 0 }; if (dispatchingRideIds.has(ride.id)) return { sent: 0, eligible: 0, skipped: true }; dispatchingRideIds.add(ride.id); try { const ageMs = Math.max(0, Date.now() - Number(ride.createdAt || Date.now())), radiusKm = dispatchRadiusKm(ageMs), drivers = await findEligibleDrivers(ride.origin, radiusKm); let sent = 0; for (const driver of drivers.slice(0, 10)) { const current = (await db.ref(`rides/${ride.id}`).get()).val(); if (!current || current.status !== 'SEARCHING' || current.driverId) break; const room = io.sockets?.adapter?.rooms?.get(`driver_${driver.uid}`), connected = room && room.size > 0; if (!connected) continue; io.to(`driver_${driver.uid}`).emit('new-ride-request', { ...current, rideId: ride.id, passengerLocation: current.passengerLocation || current.origin?.location || null, estimatedDistanceKm: Number(driver.distance.toFixed(2)), dispatchRadiusKm: radiusKm, source: 'backend-dispatch' }); sent += 1; await new Promise((resolve) => setTimeout(resolve, 8000)); const after = (await db.ref(`rides/${ride.id}`).get()).val(); if (!after || after.status !== 'SEARCHING' || after.driverId) break; } return { sent, eligible: drivers.length, radiusKm }; } catch (error) { console.error('Erro no despacho automático da corrida:', error.message); return { sent: 0, eligible: 0, error: error.message }; } finally { dispatchingRideIds.delete(ride.id); } }
router.use(authenticate);
router.post('/request', async (req, res) => { let step = 'start'; try { const { origin, destination } = req.body || {}, uid = req.user.uid; step = 'validate-payload'; if (!origin || !destination) return res.status(400).json({ error: 'Origem e destino são obrigatórios.' }); const originLocation = normalizeLocation(origin), destinationLocation = normalizeLocation(destination); if (!originLocation || !destinationLocation) return res.status(400).json({ error: 'A localização de origem e destino é inválida.' }); step = 'load-user'; const user = (await db.ref(`users/${uid}`).get()).val(); if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' }); if (user.userType !== 'passenger') return res.status(403).json({ error: 'Somente passageiros podem solicitar corridas.' }); step = 'check-active-rides'; const ridesSnapshot = await db.ref('rides').get(); let activeRide = null; ridesSnapshot.forEach((child) => { const ride = child.val(); if (ride && ride.userId === uid && ACTIVE_STATUSES.includes(ride.status)) activeRide = ride; }); if (activeRide) return res.status(409).json({ error: 'Você já possui uma corrida em andamento.', ride: activeRide }); const distanceKmValue = Math.min(Math.max(Math.round(distanceKm(originLocation, destinationLocation) * 100) / 100, 0), 300); if (distanceKmValue <= 0 || !Number.isFinite(distanceKmValue)) return res.status(400).json({ error: 'A origem e o destino precisam ser diferentes.' }); const safePrice = Number((distanceKmValue * 5 + 10).toFixed(2)); step = 'create-ride'; const ref = db.ref('rides').push(); const ride = { id: ref.key, userId: uid, driverId: null, passengerName: user.name || user.email || 'Passageiro', passengerProfilePhoto: user.profilePhoto || null, origin: { address: String(origin.address || origin.display_name || 'Minha localização atual').slice(0, 240), location: originLocation }, destination: { address: String(destination.address || destination.display_name || 'Destino').slice(0, 240), location: destinationLocation }, passengerLocation: originLocation, price: safePrice, distance: distanceKmValue, status: 'SEARCHING', createdAt: admin.database.ServerValue.TIMESTAMP }; await ref.set(ride); setImmediate(() => dispatchRide(ride)); return res.status(201).json({ success: true, ride }); } catch (error) { console.error('Erro ao solicitar corrida:', { step, message: error?.message, code: error?.code }); return res.status(500).json({ error: 'Erro interno ao criar corrida.', step, code: error?.code || 'UNKNOWN', details: error?.message || 'Erro desconhecido' }); } });
router.post('/:rideId/search', async (req, res) => { try { const rideId = req.params.rideId, snapshot = await db.ref(`rides/${rideId}`).get(), ride = snapshot.val(); if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' }); if (ride.userId !== req.user.uid) return res.status(403).json({ error: 'Acesso negado.' }); if (ride.status !== 'SEARCHING') return res.status(409).json({ error: 'Esta corrida não está mais procurando motorista.', ride }); setImmediate(() => dispatchRide(ride)); return res.status(202).json({ success: true, ride, status: 'SEARCHING' }); } catch (error) { console.error('Erro ao reiniciar busca de motorista:', error.message); return res.status(500).json({ error: 'Não foi possível reiniciar a busca de motorista.' }); } });
router.post('/:rideId/passenger-location', async (req, res) => { try { const rideId = req.params.rideId, location = normalizeLocation(req.body?.location || req.body); if (!location) return res.status(400).json({ error: 'Localização inválida.' }); const ref = db.ref(`rides/${rideId}`), ride = (await ref.get()).val(); if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' }); if (ride.userId !== req.user.uid) return res.status(403).json({ error: 'Acesso negado.' }); if (!ACTIVE_STATUSES.includes(ride.status)) return res.status(409).json({ error: 'A corrida não está ativa.' }); await ref.update({ passengerLocation: location, 'origin/location': location, updatedAt: admin.database.ServerValue.TIMESTAMP }); const updated = (await ref.get()).val(); if (updated.driverId && io) { io.to(`driver_${updated.driverId}`).emit('passenger-location-update', { rideId, passengerId: req.user.uid, location }); emitToRide(rideId, 'passenger-location-update', { rideId, passengerId: req.user.uid, location }); } return res.json({ success: true, location }); } catch (error) { console.error('Erro ao atualizar localização do passageiro:', error.message); return res.status(500).json({ error: 'Não foi possível atualizar a localização do passageiro.' }); } });
router.get('/active', async (req, res) => { try { const uid = req.user.uid, snapshot = await db.ref('rides').get(); let active = null; snapshot.forEach((child) => { const ride = child.val(); if (ride && (ride.userId === uid || ride.driverId === uid) && ACTIVE_STATUSES.includes(ride.status)) active = ride; }); return res.json({ success: true, ride: active }); } catch (error) { return res.status(500).json({ error: 'Erro ao buscar corrida ativa.' }); } });
router.post('/accept', async (req, res) => {
  const { rideId } = req.body || {};
  const driverId = req.user.uid;
  if (!rideId) return res.status(400).json({ error: 'ID da corrida é obrigatório.' });
  const lockKey = String(rideId);
  if (acceptingRideIds.has(lockKey)) return res.status(409).json({ error: 'Esta corrida já está sendo processada por outro motorista.' });
  acceptingRideIds.add(lockKey);
  try {
    const driver = (await db.ref(`users/${driverId}`).get()).val();
    if (!driver || driver.userType !== 'driver') return res.status(403).json({ error: 'Somente motoristas podem aceitar corridas.' });
    if (driver.driverApprovalStatus !== 'approved') return res.status(403).json({ error: 'Motorista ainda não foi aprovado.' });
    if (!driver.isOnline) return res.status(409).json({ error: 'Motorista está offline.' });
    const ref = db.ref(`rides/${rideId}`);
    const currentRide = (await ref.get()).val();
    if (!currentRide || currentRide.status !== 'SEARCHING' || currentRide.driverId) return res.status(409).json({ error: 'Corrida já foi aceita ou não existe.', ride: currentRide || null });
    const originLocation = normalizeLocation(currentRide.origin), driverLocation = normalizeLocation(driver.currentLocation);
    if (!originLocation || !driverLocation) return res.status(409).json({ error: 'Localização do motorista ou embarque indisponível.' });
    const ageMs = Math.max(0, Date.now() - Number(currentRide.createdAt || Date.now())), radiusKm = dispatchRadiusKm(ageMs), pickupDistanceKm = distanceKm(driverLocation, originLocation);
    if (!Number.isFinite(pickupDistanceKm) || pickupDistanceKm > radiusKm) return res.status(409).json({ error: `Você está fora da área de atendimento desta corrida (${radiusKm} km).`, estimatedDistanceKm: Number.isFinite(pickupDistanceKm) ? Number(pickupDistanceKm.toFixed(2)) : null, dispatchRadiusKm: radiusKm });
    const allRides = await db.ref('rides').get();
    let activeRide = null;
    allRides.forEach((child) => { const ride = child.val(); if (ride && String(ride.driverId || '') === String(driverId) && ACTIVE_STATUSES.includes(ride.status)) activeRide = ride; });
    if (activeRide) return res.status(409).json({ error: 'Você já possui uma corrida em andamento.', ride: activeRide });
    const latestRide = (await ref.get()).val();
    if (!latestRide || latestRide.status !== 'SEARCHING' || latestRide.driverId) return res.status(409).json({ error: 'Corrida já foi aceita ou não existe.', ride: latestRide || null });
    const accepted = { ...latestRide, driverId, driverName: driver.name || driver.email || 'Motorista', driverProfilePhoto: driver.profilePhoto || null, driverLocation: driver.currentLocation || null, passengerLocation: latestRide.passengerLocation || latestRide.origin?.location || null, status: 'ACCEPTED', acceptedAt: admin.database.ServerValue.TIMESTAMP, updatedAt: admin.database.ServerValue.TIMESTAMP };
    await ref.update(accepted);
    const confirmed = (await ref.get()).val();
    if (!confirmed || confirmed.status !== 'ACCEPTED' || String(confirmed.driverId) !== String(driverId)) return res.status(409).json({ error: 'Não foi possível confirmar a aceitação da corrida.', ride: confirmed || null });
    emitToRide(rideId, 'ride-accepted', { rideId, driverId, ride: confirmed });
    if (io) io.emit('ride-unavailable', { rideId, driverId, source: 'ride-accepted' });
    if (io) io.to(`driver_${driverId}`).emit('ride-accepted', { rideId, driverId, ride: confirmed, source: 'server-confirmation' });
    return res.json({ success: true, ride: confirmed });
  } catch (error) {
    console.error('Erro ao aceitar corrida:', error);
    return res.status(500).json({ error: 'Erro ao aceitar corrida.', code: error?.code || 'ACCEPT_RIDE_ERROR', details: error?.message || 'Erro desconhecido' });
  } finally { acceptingRideIds.delete(lockKey); }
});

async function updateRideStatus(req, res) {
  try {
    const id = req.params.rideId || req.body.rideId, { status, cancellationReason } = req.body;
    if (!id || !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Status de corrida inválido.' });
    const ref = db.ref(`rides/${id}`), snapshot = await ref.get(), ride = snapshot.val();
    if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' });
    const uid = req.user.uid;
    if (ride.userId !== uid && ride.driverId !== uid) return res.status(403).json({ error: 'Acesso negado.' });
    const allowedTransitions = { SEARCHING: ['CANCELLED'], ACCEPTED: ['IN_PROGRESS','CANCELLED'], IN_PROGRESS: ['COMPLETED','CANCELLED'], COMPLETED: [], CANCELLED: [] };
    if (!allowedTransitions[ride.status]?.includes(status)) return res.status(409).json({ error: `Transição inválida: ${ride.status} → ${status}.` });
    if (status === 'IN_PROGRESS' && ride.driverId !== uid) return res.status(403).json({ error: 'Somente o motorista pode iniciar a corrida.' });
    if (status === 'COMPLETED' && ride.driverId !== uid) return res.status(403).json({ error: 'Somente o motorista pode finalizar a corrida.' });

    if (status === 'IN_PROGRESS' || status === 'COMPLETED') {
      const driver = (await db.ref(`users/${ride.driverId}`).get()).val();
      const driverLocation = normalizeLocation(driver?.currentLocation || (await db.ref(`locations/${ride.driverId}`).get()).val());
      const target = status === 'IN_PROGRESS' ? normalizeLocation(ride.passengerLocation || ride.origin) : normalizeLocation(ride.destination);
      const distanceToTarget = distanceKm(driverLocation, target);
      if (!Number.isFinite(distanceToTarget)) return res.status(409).json({ error: 'Não foi possível confirmar a localização GPS do motorista.' });
      if (distanceToTarget > ARRIVAL_RADIUS_KM) return res.status(409).json({ error: status === 'IN_PROGRESS' ? `Chegue ao passageiro para iniciar a corrida. Distância atual: ${distanceToTarget.toFixed(2)} km.` : `Chegue ao destino para finalizar a corrida. Distância atual: ${distanceToTarget.toFixed(2)} km.` });
    }

    const update = { status, updatedAt: admin.database.ServerValue.TIMESTAMP };
    if (status === 'CANCELLED') { update.cancelledBy = uid; if (cancellationReason) update.cancellationReason = String(cancellationReason).slice(0, 200); }
    await ref.update(update);
    const updated = (await ref.get()).val(), payload = { rideId: id, ride: updated };
    if (status === 'IN_PROGRESS') emitToRide(id, 'ride-started', payload);
    if (status === 'COMPLETED') emitToRide(id, 'ride-ended', payload);
    if (status === 'CANCELLED') {
      const cancellationPayload = { ...payload, cancelledBy: uid, cancellationReason: updated?.cancellationReason || null };
      emitToRide(id, 'ride-cancelled', cancellationPayload);
      if (io && updated?.driverId && String(updated.driverId) !== String(uid)) io.to(`driver_${updated.driverId}`).emit('ride-cancelled', cancellationPayload);
      if (io && updated?.userId && String(updated.userId) !== String(uid)) io.to(`passenger_${updated.userId}`).emit('ride-cancelled', cancellationPayload);
    }
    return res.json({ success: true, status, ride: updated });
  } catch (error) { console.error('Erro ao atualizar status:', error); return res.status(500).json({ error: 'Erro ao atualizar status da corrida.' }); }
}
router.patch('/:rideId/status', updateRideStatus); router.patch('/status', updateRideStatus);
router.get('/history', async (req, res) => { try { const uid = req.user.uid; const parsedLimit = Number.parseInt(req.query.limit, 10); const limit = Number.isInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 30; const userSnapshot = await db.ref(`users/${uid}`).get(), user = userSnapshot.val(); if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' }); const snapshot = await db.ref('rides').get(); const rides = []; snapshot.forEach((child) => { const ride = child.val(); if (!ride) return; const matches = user.userType === 'driver' ? String(ride.driverId || '') === String(uid) : String(ride.userId || '') === String(uid); if (matches) rides.push(ride); }); rides.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)); return res.json({ success: true, rides: rides.slice(0, limit) }); } catch (error) { console.error('Erro ao listar histórico:', error.message); return res.status(500).json({ error: 'Erro ao buscar histórico de corridas.' }); } });
router.get('/:rideId', async (req, res) => { try { const ride = (await db.ref(`rides/${req.params.rideId}`).get()).val(); if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' }); const uid = req.user.uid; if (ride.userId !== uid && ride.driverId !== uid) return res.status(403).json({ error: 'Acesso negado.' }); return res.json({ success: true, ride }); } catch (error) { return res.status(500).json({ error: 'Erro ao buscar corrida.' }); } });
module.exports = router;
