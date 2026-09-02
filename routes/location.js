const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

const db = admin.database();
router.use(authenticate);

// Atualizar localização: somente o próprio usuário, e motorista para localização operacional.
router.post('/update', async (req, res) => {
  try {
    const activeId = req.user.uid;
    const finalLat = req.body.lat !== undefined ? req.body.lat : req.body.latitude;
    const finalLng = req.body.lng !== undefined ? req.body.lng : req.body.longitude;
    const lat = Number(finalLat);
    const lng = Number(finalLng);
    const accuracy = req.body.accuracy !== undefined ? Number(req.body.accuracy) : null;

    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Latitude ou longitude inválida.' });
    }

    const timestamp = new Date().toISOString();
    const location = { lat, lng, latitude: lat, longitude: lng, accuracy: Number.isFinite(accuracy) ? accuracy : null, timestamp };
    await db.ref(`locations/${activeId}`).set(location);

    const userSnapshot = await db.ref(`users/${activeId}`).get();
    if (userSnapshot.exists() && userSnapshot.val().userType === 'driver') {
      await db.ref(`users/${activeId}`).update({ currentLocation: { lat, lng }, lastLocationUpdate: timestamp });
    }

    return res.json({ success: true, location });
  } catch (error) {
    console.error('Erro ao atualizar localização:', error);
    return res.status(500).json({ error: 'Erro ao atualizar localização.' });
  }
});

// Obter localização do próprio usuário ou de um motorista relacionado a uma corrida ativa.
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const requesterId = req.user.uid;

    if (userId !== requesterId) {
      const ridesSnapshot = await db.ref('rides').orderByChild('userId').equalTo(requesterId).get();
      let authorized = false;
      ridesSnapshot.forEach((child) => {
        const ride = child.val();
        if (ride.driverId === userId && ['SEARCHING', 'ACCEPTED', 'IN_PROGRESS'].includes(ride.status)) authorized = true;
      });
      if (!authorized) return res.status(403).json({ error: 'Acesso à localização não autorizado.' });
    }

    const locationSnapshot = await db.ref(`locations/${userId}`).get();
    const location = locationSnapshot.val();
    if (!location) return res.status(404).json({ error: 'Localização não encontrada' });
    return res.json(location);
  } catch (error) {
    console.error('Erro ao buscar localização:', error);
    return res.status(500).json({ error: 'Erro ao buscar localização.' });
  }
});

// Histórico simplificado (posição atual); histórico detalhado pode ser adicionado futuramente.
router.get('/:userId/history', async (req, res) => {
  try {
    const { userId } = req.params;
    if (userId !== req.user.uid) return res.status(403).json({ error: 'Acesso não autorizado.' });
    const locationSnapshot = await db.ref(`locations/${userId}`).get();
    return res.json({ userId, current: locationSnapshot.val(), history: [] });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao buscar histórico.' });
  }
});

module.exports = router;
