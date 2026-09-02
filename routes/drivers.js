const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

const db = admin.database();

router.use(authenticate);

// Listar motoristas disponíveis
router.get('/available', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radius = Number(req.query.radius ?? 5);

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius) || radius <= 0) {
      return res.status(400).json({ error: 'Latitude, longitude e raio válidos são obrigatórios.' });
    }

    const driversSnapshot = await db.ref('users').orderByChild('userType').equalTo('driver').get();
    const drivers = [];

    driversSnapshot.forEach((childSnapshot) => {
      const driver = childSnapshot.val();
      if (driver.isOnline && driver.currentLocation) {
        const driverLat = Number(driver.currentLocation.lat ?? driver.currentLocation.latitude);
        const driverLng = Number(driver.currentLocation.lng ?? driver.currentLocation.longitude);
        if (!Number.isFinite(driverLat) || !Number.isFinite(driverLng)) return;

        const distance = calculateDistance(lat, lng, driverLat, driverLng);
        if (distance <= radius) {
          drivers.push({ ...driver, uid: childSnapshot.key, distance: Number(distance.toFixed(2)) });
        }
      }
    });

    drivers.sort((a, b) => a.distance - b.distance);
    return res.json({ total: drivers.length, drivers });
  } catch (error) {
    console.error('Erro ao listar motoristas:', error);
    return res.status(500).json({ error: 'Erro ao listar motoristas.' });
  }
});

// Motorista online/offline
router.post('/:driverId/status', async (req, res) => {
  try {
    const { driverId } = req.params;
    const { isOnline, currentLocation } = req.body;

    if (driverId !== req.user.uid) return res.status(403).json({ error: 'Você só pode alterar o próprio status.' });
    if (typeof isOnline !== 'boolean') return res.status(400).json({ error: 'isOnline deve ser booleano.' });

    const driverSnapshot = await db.ref(`users/${driverId}`).get();
    const driver = driverSnapshot.val();
    if (!driver || driver.userType !== 'driver') return res.status(403).json({ error: 'Usuário não é motorista.' });

    const update = { isOnline, lastLocationUpdate: new Date().toISOString() };
    if (currentLocation !== undefined) {
      const lat = Number(currentLocation.lat ?? currentLocation.latitude);
      const lng = Number(currentLocation.lng ?? currentLocation.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'Localização inválida.' });
      update.currentLocation = { lat, lng };
      await db.ref(`locations/${driverId}`).set({ lat, lng, latitude: lat, longitude: lng, timestamp: new Date().toISOString() });
    }

    await db.ref(`users/${driverId}`).update(update);
    return res.json({ message: 'Status atualizado', isOnline });
  } catch (error) {
    console.error('Erro ao atualizar status:', error);
    return res.status(500).json({ error: 'Erro ao atualizar status.' });
  }
});

// Obter perfil do motorista
router.get('/:driverId', async (req, res) => {
  try {
    const driverSnapshot = await db.ref(`users/${req.params.driverId}`).get();
    const driver = driverSnapshot.val();
    if (!driver) return res.status(404).json({ error: 'Motorista não encontrado' });
    return res.json(driver);
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao buscar motorista.' });
  }
});

// Adicionar avaliação
router.post('/:driverId/rating', async (req, res) => {
  try {
    const { driverId } = req.params;
    const rating = Number(req.body.rating);
    const comment = typeof req.body.comment === 'string' ? req.body.comment.trim().slice(0, 500) : '';

    if (!Number.isFinite(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Avaliação deve ser entre 1 e 5' });
    if (driverId === req.user.uid) return res.status(403).json({ error: 'Motorista não pode avaliar a si mesmo.' });

    const driverSnapshot = await db.ref(`users/${driverId}`).get();
    if (!driverSnapshot.exists() || driverSnapshot.val().userType !== 'driver') return res.status(404).json({ error: 'Motorista não encontrado.' });

    await db.ref(`ratings/${driverId}`).push({ rating, comment, passengerId: req.user.uid, createdAt: new Date().toISOString() });

    const ratingsSnapshot = await db.ref(`ratings/${driverId}`).get();
    let totalRating = 0;
    let count = 0;
    ratingsSnapshot.forEach((childSnapshot) => {
      const value = childSnapshot.val();
      totalRating += Number(value.rating) || 0;
      count++;
    });

    const avgRating = count ? Number((totalRating / count).toFixed(1)) : 0;
    await db.ref(`users/${driverId}`).update({ rating: avgRating });
    return res.json({ message: 'Avaliação registrada', rating: avgRating });
  } catch (error) {
    console.error('Erro ao registrar avaliação:', error);
    return res.status(500).json({ error: 'Erro ao registrar avaliação.' });
  }
});

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = router;
