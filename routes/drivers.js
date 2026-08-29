const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();

const db = admin.database();

// Listar motoristas disponíveis
router.get('/available', async (req, res) => {
  try {
    const { lat, lng, radius = 5 } = req.query; // radius em km

    const driversSnapshot = await db.ref('users').orderByChild('userType').equalTo('driver').get();
    const drivers = [];

    driversSnapshot.forEach((childSnapshot) => {
      const driver = childSnapshot.val();
      if (driver.isOnline && driver.currentLocation) {
        // Calcular distância (fórmula de Haversine)
        const distance = calculateDistance(
          lat,
          lng,
          driver.currentLocation.lat,
          driver.currentLocation.lng
        );

        if (distance <= radius) {
          drivers.push({
            ...driver,
            distance: distance.toFixed(2)
          });
        }
      }
    });

    // Ordenar por distância
    drivers.sort((a, b) => parseFloat(a.distance) - parseFloat(b.distance));

    res.json({
      total: drivers.length,
      drivers
    });
  } catch (error) {
    console.error('Erro ao listar motoristas:', error);
    res.status(500).json({ error: error.message });
  }
});

// Motorista online/offline
router.post('/:driverId/status', async (req, res) => {
  try {
    const { driverId } = req.params;
    const { isOnline, currentLocation } = req.body;

    await db.ref(`users/${driverId}`).update({
      isOnline,
      currentLocation,
      lastLocationUpdate: new Date().toISOString()
    });

    res.json({ message: 'Status atualizado' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obter perfil do motorista
router.get('/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    const driverSnapshot = await db.ref(`users/${driverId}`).get();
    const driver = driverSnapshot.val();

    if (!driver) {
      return res.status(404).json({ error: 'Motorista não encontrado' });
    }

    res.json(driver);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Adicionar avaliação
router.post('/:driverId/rating', async (req, res) => {
  try {
    const { driverId } = req.params;
    const { rating, comment } = req.body;

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Avaliação deve ser entre 1 e 5' });
    }

    // Salvar avaliação
    await db.ref(`ratings/${driverId}`).push({
      rating,
      comment,
      createdAt: new Date().toISOString()
    });

    // Calcular média
    const ratingsSnapshot = await db.ref(`ratings/${driverId}`).get();
    let totalRating = 0;
    let count = 0;

    ratingsSnapshot.forEach((childSnapshot) => {
      totalRating += childSnapshot.val().rating;
      count++;
    });

    const avgRating = (totalRating / count).toFixed(1);

    // Atualizar rating do motorista
    await db.ref(`users/${driverId}`).update({
      rating: parseFloat(avgRating)
    });

    res.json({ message: 'Avaliação registrada', rating: avgRating });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Função para calcular distância
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Raio da Terra em km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

module.exports = router;
