const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { authenticate } = require('../middleware/auth');

const db = admin.database();
const VALID_STATUSES = ['SEARCHING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
const ACTIVE_STATUSES = ['SEARCHING', 'ACCEPTED', 'IN_PROGRESS'];

router.use(authenticate);

router.post('/request', async (req, res) => {
  try {
    const { origin, destination, price, distance } = req.body;
    const userId = req.user.uid;
    if (!origin || !destination) return res.status(400).json({ error: 'Origem e destino são obrigatórios.' });

    const userSnapshot = await db.ref(`users/${userId}`).get();
    const user = userSnapshot.val();
    if (!user || user.userType !== 'passenger') return res.status(403).json({ error: 'Somente passageiros podem solicitar corridas.' });

    const ridesSnapshot = await db.ref('rides').orderByChild('userId').equalTo(userId).get();
    let activeRide = null;
    ridesSnapshot.forEach(child => {
      const ride = child.val();
      if (ACTIVE_STATUSES.includes(ride.status)) activeRide = ride;
    });
    if (activeRide) return res.status(409).json({ error: 'Você já possui uma corrida em andamento.', ride: activeRide });

    const newRideRef = db.ref('rides').push();
    const rideData = {
      id: newRideRef.key, userId, driverId: null, origin, destination,
      price: Number(price) || 0, distance: Number(distance) || 0,
      status: 'SEARCHING', createdAt: admin.database.ServerValue.TIMESTAMP
    };
    await newRideRef.set(rideData);
    return res.status(201).json({ success: true, ride: rideData });
  } catch (error) {
    console.error('Erro ao solicitar corrida:', error);
    return res.status(500).json({ error: 'Erro interno ao criar corrida.' });
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
    activeRidesSnapshot.forEach(child => {
      const ride = child.val();
      if (ACTIVE_STATUSES.includes(ride.status)) activeDriverRide = ride;
    });
    if (activeDriverRide) {
      return res.status(409).json({
        error: 'Você já possui uma corrida em andamento. Finalize ou cancele a corrida atual antes de aceitar outra.',
        ride: activeDriverRide
      });
    }

    const rideRef = db.ref(`rides/${rideId}`);
    const result = await rideRef.transaction((ride) => {
      if (!ride || ride.status !== 'SEARCHING' || ride.driverId) return;
      ride.driverId = driverId;
      ride.status = 'ACCEPTED';
      ride.acceptedAt = admin.database.ServerValue.TIMESTAMP;
      return ride;
    });

    if (!result.committed) return res.status(409).json({ error: 'Corrida já foi aceita ou não existe.' });
    return res.json({ success: true, ride: result.snapshot.val() });
  } catch (error) {
    console.error('Erro ao aceitar corrida:', error);
    return res.status(500).json({ error: 'Erro ao aceitar corrida.' });
  }
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

    const allowedTransitions = {
      SEARCHING: ['CANCELLED'],
      ACCEPTED: ['IN_PROGRESS', 'CANCELLED'],
      IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: []
    };
    if (!allowedTransitions[ride.status]?.includes(status)) {
      return res.status(409).json({ error: `Não é possível mudar de ${ride.status} para ${status}.` });
    }

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
    return res.json({ success: true, status, ride: updatedSnapshot.val() });
  } catch (error) {
    console.error('Erro ao atualizar status:', error);
    return res.status(500).json({ error: 'Erro ao atualizar status da corrida.' });
  }
}

router.patch('/:rideId/status', updateRideStatus);
router.patch('/status', updateRideStatus);

router.get('/:rideId', async (req, res) => {
  try {
    const snapshot = await db.ref(`rides/${req.params.rideId}`).get();
    const ride = snapshot.val();
    if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' });
    if (ride.userId !== req.user.uid && ride.driverId !== req.user.uid) return res.status(403).json({ error: 'Acesso negado.' });
    return res.json({ success: true, ride });
  } catch (error) {
    console.error('Erro ao buscar corrida:', error);
    return res.status(500).json({ error: 'Erro interno ao buscar corrida.' });
  }
});

module.exports = router;
