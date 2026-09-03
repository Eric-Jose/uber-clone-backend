const express = require('express');
const admin = require('firebase-admin');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const db = admin.database();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const driverId = req.user.uid;
    const driverSnapshot = await db.ref(`users/${driverId}`).get();
    const driver = driverSnapshot.val();

    if (!driver || driver.userType !== 'driver') {
      return res.status(403).json({ error: 'Somente motoristas podem consultar pedidos.' });
    }
    if (driver.driverApprovalStatus !== 'approved') {
      return res.status(403).json({ error: 'Motorista ainda não foi aprovado.' });
    }
    if (driver.isOnline !== true) {
      return res.json({ success: true, rides: [] });
    }

    const ridesSnapshot = await db.ref('rides').get();
    const rides = [];
    const now = Date.now();

    ridesSnapshot.forEach(child => {
      const ride = child.val();
      if (!ride || ride.status !== 'SEARCHING' || ride.driverId) return;

      const createdAt = Number(ride.createdAt || 0);
      if (createdAt > 0 && now - createdAt > 10 * 60 * 1000) return;
      rides.push(ride);
    });

    rides.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    return res.json({ success: true, rides });
  } catch (error) {
    console.error('Erro ao buscar pedidos pendentes:', error);
    return res.status(500).json({ error: 'Erro ao buscar pedidos pendentes.' });
  }
});

module.exports = router;
