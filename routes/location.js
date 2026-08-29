const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();

const db = admin.database();

// Atualizar localização em tempo real
router.post('/update', async (req, res) => {
  try {
    const { userId, lat, lng, accuracy } = req.body;

    if (!userId || lat === undefined || lng === undefined) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    await db.ref(`locations/${userId}`).set({
      lat,
      lng,
      accuracy: accuracy || null,
      timestamp: new Date().toISOString()
    });

    res.json({ message: 'Localização atualizada' });
  } catch (error) {
    console.error('Erro ao atualizar localização:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter localização de um usuário
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const locationSnapshot = await db.ref(`locations/${userId}`).get();
    const location = locationSnapshot.val();

    if (!location) {
      return res.status(404).json({ error: 'Localização não encontrada' });
    }

    res.json(location);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Histórico de localização (últimas 24h)
router.get('/:userId/history', async (req, res) => {
  try {
    const { userId } = req.params;
    // Implementação completa depende de como você quer armazenar histórico
    // Por enquanto, retornar localização atual
    const locationSnapshot = await db.ref(`locations/${userId}`).get();
    const location = locationSnapshot.val();

    res.json({
      userId,
      current: location,
      history: [] // Para implementar depois com banco mais robusto
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
