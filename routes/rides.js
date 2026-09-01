const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');

// Criar nova solicitação de corrida
router.post('/request', async (req, res) => {
  try {
    const { userId, origin, destination, price, distance } = req.body;

    if (!userId || !origin || !destination) {
      return res.status(400).json({ error: 'Dados incompletos para solicitar corrida.' });
    }

    const db = admin.database();
    const newRideRef = db.ref('rides').push();

    const rideData = {
      id: newRideRef.key,
      userId,
      driverId: null,
      origin,
      destination,
      price,
      distance,
      status: 'SEARCHING', // SEARCHING, ACCEPTED, IN_PROGRESS, COMPLETED, CANCELLED
      createdAt: admin.database.ServerValue.TIMESTAMP
    };

    await newRideRef.set(rideData);

    return res.status(201).json({ success: true, ride: rideData });
  } catch (error) {
    console.error('Erro ao solicitar corrida:', error);
    return res.status(500).json({ error: 'Erro interno ao criar corrida.' });
  }
});

// Aceitar corrida (Motorista)
router.post('/accept', async (req, res) => {
  try {
    const { rideId, driverId } = req.body;

    if (!rideId || !driverId) {
      return res.status(400).json({ error: 'IDs da corrida e do motorista são obrigatórios.' });
    }

    const db = admin.database();
    const rideRef = db.ref(`rides/${rideId}`);

    await rideRef.update({
      driverId,
      status: 'ACCEPTED',
      acceptedAt: admin.database.ServerValue.TIMESTAMP
    });

    return res.json({ success: true, message: 'Corrida aceita com sucesso.' });
  } catch (error) {
    console.error('Erro ao aceitar corrida:', error);
    return res.status(500).json({ error: 'Erro ao aceitar corrida.' });
  }
});

// Atualizar status da corrida (IN_PROGRESS, COMPLETED, CANCELLED)
router.patch('/status', async (req, res) => {
  try {
    const { rideId, status } = req.body;

    if (!rideId || !status) {
      return res.status(400).json({ error: 'Dados insuficientes para atualizar status.' });
    }

    const db = admin.database();
    await db.ref(`rides/${rideId}`).update({ status });

    return res.json({ success: true, status });
  } catch (error) {
    console.error('Erro ao atualizar status:', error);
    return res.status(500).json({ error: 'Erro ao atualizar status da corrida.' });
  }
});

module.exports = router;
