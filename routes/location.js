const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();

// Atualizar localização em tempo real
router.post('/update', async (req, res) => {
  try {
    const { userId, driverId, lat, lng, latitude, longitude, accuracy } = req.body;

    // Aceita tanto userId quanto driverId, e tanto (lat, lng) quanto (latitude, longitude)
    const activeId = userId || driverId;
    const finalLat = lat !== undefined ? lat : latitude;
    const finalLng = lng !== undefined ? lng : longitude;

    if (!activeId || finalLat === undefined || finalLng === undefined) {
      return res.status(400).json({ error: 'Dados incompletos para atualizar localização' });
    }

    const db = admin.database();

    await db.ref(`locations/${activeId}`).set({
      lat: finalLat,
      lng: finalLng,
      latitude: finalLat,
      longitude: finalLng,
      accuracy: accuracy || null,
      timestamp: new Date().toISOString()
    });

    return res.json({ success: true, message: 'Localização atualizada com sucesso' });
  } catch (error) {
    console.error('Erro ao atualizar localização:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Obter localização de um usuário/motorista
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = admin.database();

    const locationSnapshot = await db.ref(`locations/${userId}`).get();
    const location = locationSnapshot.val();

    if (!location) {
      return res.status(404).json({ error: 'Localização não encontrada' });
    }

    return res.json(location);
  } catch (error) {
    console.error('Erro ao buscar localização:', error);
    return res.status(500).json({ error: error.message });
  }
});

// Histórico de localização
router.get('/:userId/history', async (req, res) => {
  try {
    const { userId } = req.params;
    const db = admin.database();

    const locationSnapshot = await db.ref(`locations/${userId}`).get();
    const location = locationSnapshot.val();

    return res.json({
      userId,
      current: location,
      history: []
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
