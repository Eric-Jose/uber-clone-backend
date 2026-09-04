const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { authenticate } = require('../middleware/auth');

const db = admin.database();
let io = null;
const dispatchingRideIds = new Set();

const VALID_STATUSES = ['SEARCHING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const ACTIVE_STATUSES = ['SEARCHING', 'ACCEPTED', 'IN_PROGRESS'];

router.setSocketIo = (socketIo) => {
  io = socketIo;
};

router.use(authenticate);

function emitToRide(id, event, payload) {
  if (io && id) io.to(`ride_${id}`).emit(event, payload);
}

function normalizeLocation(value) {
  const source = value?.location || value?.currentLocation || value || {};
  const lat = Number(source.lat ?? source.latitude);
  const lng = Number(source.lng ?? source.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function distanceKm(a, b) {
  const lat1 = Number(a?.lat ?? a?.latitude);
  const lon1 = Number(a?.lng ?? a?.longitude);
  const lat2 = Number(b?.lat ?? b?.latitude);
  const lon2 = Number(b?.lng ?? b?.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;

  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180)
    * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

async function findEligibleDrivers(origin) {
  const [usersSnapshot, locationsSnapshot] = await Promise.all([
    db.ref('users').get(),
    db.ref('locations').get()
  ]);

  const users = usersSnapshot.val() || {};
  const locations = locationsSnapshot.val() || {};
  const originLocation = normalizeLocation(origin);
  const drivers = [];

  for (const [uid, user] of Object.entries(users)) {
    if (user?.userType !== 'driver') continue;
    if (user?.driverApprovalStatus !== 'approved') continue;
    if (user?.isOnline !== true) continue;

    const location = normalizeLocation(user.currentLocation || locations[uid]);
    const distance = distanceKm(originLocation, location);
    if (Number.isFinite(distance)) drivers.push({ uid, distance });
  }

  return drivers.sort((a, b) => a.distance - b.distance);
}

async function dispatchRide(ride) {
  if (!io || !ride?.id || ride.status !== 'SEARCHING') return { sent: 0, eligible: 0 };
  if (dispatchingRideIds.has(ride.id)) return { sent: 0, eligible: 0, skipped: true };

  dispatchingRideIds.add(ride.id);
  try {
    const drivers = await findEligibleDrivers(ride.origin);
    let sent = 0;

    for (const driver of drivers.slice(0, 10)) {
      const current = (await db.ref(`rides/${ride.id}`).get()).val();
      if (!current || current.status !== 'SEARCHING' || current.driverId) break;

      const room = io.sockets?.adapter?.rooms?.get(`driver_${driver.uid}`);
      const connected = room && room.size > 0;
      if (!connected) continue;

      io.to(`driver_${driver.uid}`).emit('new-ride-request', {
        ...current,
        rideId: ride.id,
        passengerLocation: current.passengerLocation || current.origin?.location || null,
        estimatedDistanceKm: Number(driver.distance.toFixed(2)),
        source: 'backend-dispatch'
      });
      sent += 1;

      await new Promise((resolve) => setTimeout(resolve, 8000));
      const after = (await db.ref(`rides/${ride.id}`).get()).val();
      if (!after || after.status !== 'SEARCHING' || after.driverId) break;
    }

    if (sent === 0 && drivers.length > 0) {
      const current = (await db.ref(`rides/${ride.id}`).get()).val();
      if (current?.status === 'SEARCHING' && !current.driverId) {
        io.to('available_drivers').emit('new-ride-request', {
          ...current,
          rideId: ride.id,
          passengerLocation: current.passengerLocation || current.origin?.location || null,
          source: 'available-drivers-fallback'
        });
        sent = 1;
      }
    }

    return { sent, eligible: drivers.length };
  } catch (error) {
    console.error('Erro no despacho automático da corrida:', error.message);
    return { sent: 0, eligible: 0, error: error.message };
  } finally {
    dispatchingRideIds.delete(ride.id);
  }
}

router.post('/request', async (req, res) => {
  let step = 'start';
  try {
    const { origin, destination } = req.body || {};
    const uid = req.user.uid;
    step = 'validate-payload';

    if (!origin || !destination) return res.status(400).json({ error: 'Origem e destino são obrigatórios.' });

    const originLocation = normalizeLocation(origin);
    const destinationLocation = normalizeLocation(destination);
    if (!originLocation || !destinationLocation) return res.status(400).json({ error: 'A localização de origem e destino é inválida.' });

    step = 'load-user';
    const userSnapshot = await db.ref(`users/${uid}`).get();
    const user = userSnapshot.val();
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (user.userType !== 'passenger') return res.status(403).json({ error: 'Somente passageiros podem solicitar corridas.' });

    step = 'check-active-rides';
    const ridesSnapshot = await db.ref('rides').get();
    let activeRide = null;
    ridesSnapshot.forEach((child) => {
      const ride = child.val();
      if (ride && ride.userId === uid && ACTIVE_STATUSES.includes(ride.status)) activeRide = ride;
    });
    if (activeRide) return res.status(409).json({ error: 'Você já possui uma corrida em andamento.', ride: activeRide });

    const distanceKmValue = Math.min(Math.max(Math.round(haversine(originLocation, destinationLocation) * 100) / 100, 0), 300);
    if (distanceKmValue <= 0) return res.status(400).json({ error: 'A origem e o destino precisam ser diferentes.' });

    const safePrice = Number((distanceKmValue * 5 + 10).toFixed(2));
    step = 'create-ride';

    const ref = db.ref('rides').push();
    const ride = {
      id: ref.key,
      userId: uid,
      driverId: null,
      passengerName: user.name || user.email || 'Passageiro',
      passengerProfilePhoto: user.profilePhoto || null,
      origin: {
        address: String(origin.address || origin.display_name || 'Minha localização atual').slice(0, 240),
        location: originLocation
      },
      destination: {
        address: String(destination.address || destination.display_name || 'Destino').slice(0, 240),
        location: destinationLocation
      },
      passengerLocation: originLocation,
      price: safePrice,
      distance: distanceKmValue,
      status: 'SEARCHING',
      createdAt: admin.database.ServerValue.TIMESTAMP
    };

    await ref.set(ride);
    setImmediate(() => dispatchRide(ride));

    return res.status(201).json({ success: true, ride });
  } catch (error) {
    console.error('Erro ao solicitar corrida:', { step, message: error?.message, code: error?.code });
    return res.status(500).json({ error: 'Erro interno ao criar corrida.', step, code: error?.code || 'UNKNOWN', details: error?.message || 'Erro desconhecido' });
  }
});

router.post('/:rideId/search', async (req, res) => {
  try {
    const rideId = req.params.rideId;
    const snapshot = await db.ref(`rides/${rideId}`).get();
    const ride = snapshot.val();
    if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' });
    if (ride.userId !== req.user.uid) return res.status(403).json({ error: 'Acesso negado.' });
    if (ride.status !== 'SEARCHING') return res.status(409).json({ error: 'Esta corrida não está mais procurando motorista.', ride });
    setImmediate(() => dispatchRide(ride));
    return res.status(202).json({ success: true, ride, status: 'SEARCHING' });
  } catch (error) {
    console.error('Erro ao reiniciar busca de motorista:', error.message);
    return res.status(500).json({ error: 'Não foi possível reiniciar a busca de motorista.' });
  }
});

router.post('/:rideId/passenger-location', async (req, res) => {
  try {
    const rideId = req.params.rideId;
    const location = normalizeLocation(req.body?.location || req.body);
    if (!location) return res.status(400).json({ error: 'Localização inválida.' });
    const ref = db.ref(`rides/${rideId}`);
    const ride = (await ref.get()).val();
    if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' });
    if (ride.userId !== req.user.uid) return res.status(403).json({ error: 'Acesso negado.' });
    if (!ACTIVE_STATUSES.includes(ride.status)) return res.status(409).json({ error: 'A corrida não está ativa.' });

    await ref.update({ passengerLocation: location, 'origin/location': location, updatedAt: admin.database.ServerValue.TIMESTAMP });
    const updated = (await ref.get()).val();
    if (updated.driverId && io) {
      io.to(`driver_${updated.driverId}`).emit('passenger-location-update', { rideId, passengerId: req.user.uid, location });
      emitToRide(rideId, 'passenger-location-update', { rideId, passengerId: req.user.uid, location });
    }
    return res.json({ success: true, location });
  } catch (error) {
    console.error('Erro ao atualizar localização do passageiro:', error.message);
    return res.status(500).json({ error: 'Não foi possível atualizar a localização do passageiro.' });
  }
});

router.get('/active', async (req, res) => {
  try {
    const uid = req.user.uid;
    const snapshot = await db.ref('rides').get();
    let active = null;
    snapshot.forEach((child) => {
      const ride = child.val();
      if (ride && (ride.userId === uid || ride.driverId === uid) && ACTIVE_STATUSES.includes(ride.status)) active = ride;
    });
    return res.json({ success: true, ride: active });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao buscar corrida ativa.' });
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

    const activeByDriver = await db.ref('rides').orderByChild('driverId').equalTo(driverId).get();
    let activeRide = null;
    activeByDriver.forEach((child) => {
      const ride = child.val();
      if (ACTIVE_STATUSES.includes(ride.status)) activeRide = ride;
    });
    if (activeRide) return res.status(409).json({ error: 'Você já possui uma corrida em andamento.', ride: activeRide });

    const ref = db.ref(`rides/${rideId}`);
    const result = await ref.transaction((value) => {
      if (!value || value.status !== 'SEARCHING' || value.driverId) return;
      value.driverId = driverId;
      value.driverName = driver.name || driver.email || 'Motorista';
      value.driverProfilePhoto = driver.profilePhoto || null;
      value.driverLocation = driver.currentLocation || null;
      value.passengerLocation = value.passengerLocation || value.origin?.location || null;
      value.status = 'ACCEPTED';
      value.acceptedAt = admin.database.ServerValue.TIMESTAMP;
      return value;
    });

    if (!result.committed) return res.status(409).json({ error: 'Corrida já foi aceita ou não existe.' });

    const accepted = result.snapshot.val();
    emitToRide(rideId, 'ride-accepted', { rideId, driverId, ride: accepted });
    if (io) io.emit('ride-unavailable', { rideId, driverId, source: 'ride-accepted' });

    return res.json({ success: true, ride: accepted });
  } catch (error) {
    console.error('Erro ao aceitar corrida:', error);
    return res.status(500).json({ error: 'Erro ao aceitar corrida.' });
  }
});

async function updateRideStatus(req, res) {
  try {
    const id = req.params.rideId || req.body.rideId;
    const { status, cancellationReason } = req.body;
    if (!id || !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Status de corrida inválido.' });

    const ref = db.ref(`rides/${id}`);
    const snapshot = await ref.get();
    const ride = snapshot.val();
    if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' });

    const uid = req.user.uid;
    if (ride.userId !== uid && ride.driverId !== uid) return res.status(403).json({ error: 'Você não pertence a esta corrida.' });

    const transitions = { SEARCHING: ['CANCELLED'], ACCEPTED: ['IN_PROGRESS', 'CANCELLED'], IN_PROGRESS: ['COMPLETED', 'CANCELLED'], COMPLETED: [], CANCELLED: [] };
    if (!transitions[ride.status]?.includes(status)) return res.status(409).json({ error: `Não é possível mudar de ${ride.status} para ${status}.` });

    const passengerCancel = status === 'CANCELLED' && ride.userId === uid;
    const driverChange = ride.driverId === uid && ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(status);
    if (!passengerCancel && !driverChange) return res.status(403).json({ error: 'Você não tem permissão para essa mudança.' });

    const update = { status, updatedAt: admin.database.ServerValue.TIMESTAMP };
    if (status === 'CANCELLED') {
      update.cancelledBy = uid;
      update.cancelledAt = admin.database.ServerValue.TIMESTAMP;
      if (cancellationReason) update.cancellationReason = String(cancellationReason).slice(0, 200);
    }

    await ref.update(update);
    const updated = (await ref.get()).val();
    const payload = { rideId: id, ride: updated };
    if (status === 'IN_PROGRESS') emitToRide(id, 'ride-started', payload);
    if (status === 'COMPLETED') emitToRide(id, 'ride-ended', payload);
    if (status === 'CANCELLED') emitToRide(id, 'ride-cancelled', { ...payload, cancelledBy: uid, cancellationReason: updated?.cancellationReason || null });

    return res.json({ success: true, status, ride: updated });
  } catch (error) {
    console.error('Erro ao atualizar status:', error);
    return res.status(500).json({ error: 'Erro ao atualizar status da corrida.' });
  }
}

router.patch('/:rideId/status', updateRideStatus);
router.patch('/status', updateRideStatus);

router.get('/history', async (req, res) => {
  try {
    const uid = req.user.uid;
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 30;
    const userSnapshot = await db.ref(`users/${uid}`).get();
    const user = userSnapshot.val();
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const field = user.userType === 'driver' ? 'driverId' : 'userId';
    const snapshot = await db.ref('rides').orderByChild(field).equalTo(uid).get();
    const rides = [];
    snapshot.forEach((child) => rides.push(child.val()));
    rides.sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0));

    return res.json({ success: true, rides: rides.slice(0, limit) });
  } catch (error) {
    console.error('Erro ao buscar histórico:', error);
    return res.status(500).json({ error: 'Erro interno ao buscar histórico de corridas.' });
  }
});

router.get('/:rideId', async (req, res) => {
  try {
    const ride = (await db.ref(`rides/${req.params.rideId}`).get()).val();
    if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' });
    if (ride.userId !== req.user.uid && ride.driverId !== req.user.uid) return res.status(403).json({ error: 'Acesso negado.' });
    return res.json({ success: true, ride });
  } catch (error) {
    return res.status(500).json({ error: 'Erro interno ao buscar corrida.' });
  }
});

function haversine(a, b) {
  const R = 6371;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLat = lat2 - lat1;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

module.exports = router;
