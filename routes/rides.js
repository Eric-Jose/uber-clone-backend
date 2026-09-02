const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

const db = admin.database();
const VALID_STATUSES = ['SEARCHING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

router.post('/request', async (req, res) => {
  try {
    const { userId, origin, destination, price, distance } = req.body;
    if (!userId || !origin || !destination) return res.status(400).json({ error: 'Dados incompletos para solicitar corrida.' });

    const userSnapshot = await db.ref(`users/${userId}`).get();
    if (!userSnapshot.exists()) return res.status(404).json({ error: 'Passageiro não encontrado.' });

    const newRideRef = db.ref('rides').push();
    const rideData = {
      id: newRideRef.key,
      userId,
      driverId: null,
      origin,
      destination,
      price: Number(price) || 0,
      distance: Number(distance) || 0,
      status: 'SEARCHING',
      createdAt: admin.database.ServerValue.TIMESTAMP
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
    const { rideId, driverId } = req.body;
    if (!rideId || !driverId) return res.status(400).json({ error: 'IDs da corrida e do motorista são obrigatórios.' });

    const driverSnapshot = await db.ref(`users/${driverId}`).get();
    const driver = driverSnapshot.val();
    if (!driver || driver.userType !== 'driver') return res.status(403).json({ error: 'Motorista inválido.' });
    if (!driver.isOnline) return res.status(409).json({ error: 'Motorista está offline.' });

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

router.patch('/status', async (req, res) => {
  try {
    const { rideId, status, driverId, userId } = req.body;
    if (!rideId || !status || !VALID_STATUSES.includes(status)) return res.status(400).json({ error: 'Status de corrida inválido.' });

    const rideRef = db.ref(`rides/${rideId}`);
    const snapshot = await rideRef.get();
    const ride = snapshot.val();
    if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' });
    if (driverId && ride.driverId !== driverId) return res.status(403).json({ error: 'Motorista não pertence a esta corrida.' });
    if (userId && ride.userId !== userId) return res.status(403).json({ error: 'Passageiro não pertence a esta corrida.' });

    const allowedTransitions = {
      SEARCHING: ['CANCELLED', 'ACCEPTED'],
      ACCEPTED: ['IN_PROGRESS', 'CANCELLED'],
      IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: []
    };
    if (!allowedTransitions[ride.status].includes(status)) return res.status(409).json({ error: `Não é possível mudar de ${ride.status} para ${status}.` });

    await rideRef.update({ status, updatedAt: admin.database.ServerValue.TIMESTAMP });
    return res.json({ success: true, status });
  } catch (error) {
    console.error('Erro ao atualizar status:', error);
    return res.status(500).json({ error: 'Erro ao atualizar status da corrida.' });
  }
});

router.get('/:rideId', async (req, res) => {
  try {
    const snapshot = await db.ref(`rides/${req.params.rideId}`).get();
    const ride = snapshot.val();
    if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' });
    return res.json({ success: true, ride });
  } catch (error) {
    console.error('Erro ao buscar corrida:', error);
    return res.status(500).json({ error: 'Erro interno ao buscar corrida.' });
  }
});

module.exports = router;
