const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();

const db = admin.database();

// Solicitar corrida
router.post('/request', async (req, res) => {
  try {
    const { userId, pickup, destination, pickupLat, pickupLng, destinationLat, destinationLng } = req.body;

    if (!userId || !pickup || !destination) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    // Criar novo registro de corrida
    const rideRef = await db.ref('rides').push({
      userId,
      status: 'searching', // searching, accepted, started, completed, cancelled
      pickup,
      destination,
      pickupLocation: { lat: pickupLat, lng: pickupLng },
      destinationLocation: { lat: destinationLat, lng: destinationLng },
      driverId: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      price: null,
      rating: null
    });

    res.status(201).json({
      message: 'Corrida solicitada com sucesso',
      rideId: rideRef.key
    });
  } catch (error) {
    console.error('Erro ao solicitar corrida:', error);
    res.status(500).json({ error: error.message });
  }
});

// Motorista aceita corrida
router.post('/:rideId/accept', async (req, res) => {
  try {
    const { rideId } = req.params;
    const { driverId } = req.body;

    await db.ref(`rides/${rideId}`).update({
      driverId,
      status: 'accepted',
      acceptedAt: new Date().toISOString()
    });

    res.json({ message: 'Corrida aceita' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Iniciar corrida
router.post('/:rideId/start', async (req, res) => {
  try {
    const { rideId } = req.params;

    await db.ref(`rides/${rideId}`).update({
      status: 'started',
      startedAt: new Date().toISOString()
    });

    res.json({ message: 'Corrida iniciada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Finalizar corrida
router.post('/:rideId/complete', async (req, res) => {
  try {
    const { rideId } = req.params;
    const { price } = req.body;

    await db.ref(`rides/${rideId}`).update({
      status: 'completed',
      completedAt: new Date().toISOString(),
      price
    });

    res.json({ message: 'Corrida finalizada', price });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancelar corrida
router.post('/:rideId/cancel', async (req, res) => {
  try {
    const { rideId } = req.params;
    const { reason } = req.body;

    await db.ref(`rides/${rideId}`).update({
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancellationReason: reason
    });

    res.json({ message: 'Corrida cancelada' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obter detalhes da corrida
router.get('/:rideId', async (req, res) => {
  try {
    const { rideId } = req.params;
    const rideSnapshot = await db.ref(`rides/${rideId}`).get();
    const ride = rideSnapshot.val();

    if (!ride) {
      return res.status(404).json({ error: 'Corrida não encontrada' });
    }

    res.json(ride);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Histórico de corridas do usuário
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const ridesSnapshot = await db.ref('rides').orderByChild('userId').equalTo(userId).get();
    const rides = [];

    ridesSnapshot.forEach((childSnapshot) => {
      rides.push({
        id: childSnapshot.key,
        ...childSnapshot.val()
      });
    });

    res.json({
      total: rides.length,
      rides: rides.reverse() // Mais recentes primeiro
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
