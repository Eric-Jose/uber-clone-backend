const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

const db = admin.database();
router.use(authenticate);

async function requireAdmin(req, res, next) {
  try {
    const snap = await db.ref(`users/${req.user.uid}`).get();
    const user = snap.val();
    if (!user || user.userType !== 'admin') return res.status(403).json({ error: 'Acesso administrativo necessário.' });
    next();
  } catch (error) {
    return res.status(500).json({ error: 'Não foi possível validar o administrador.' });
  }
}

router.get('/overview', requireAdmin, async (req, res) => {
  try {
    const [usersSnapshot, ridesSnapshot] = await Promise.all([
      db.ref('users').get(),
      db.ref('rides').get()
    ]);

    let passengers = 0;
    let drivers = 0;
    let approvedDrivers = 0;
    let onlineDrivers = 0;
    const rides = [];

    usersSnapshot.forEach((child) => {
      const user = child.val() || {};
      if (user.userType === 'passenger') passengers += 1;
      if (user.userType === 'driver') {
        drivers += 1;
        if (user.driverApprovalStatus === 'approved') approvedDrivers += 1;
        if (user.driverApprovalStatus === 'approved' && user.isOnline === true) onlineDrivers += 1;
      }
    });

    ridesSnapshot.forEach((child) => {
      const ride = child.val();
      if (ride) rides.push(ride);
    });

    const today = new Date();
    const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const start7Days = startToday - (6 * 24 * 60 * 60 * 1000);

    let ridesToday = 0;
    let completedToday = 0;
    let cancelledToday = 0;
    let activeRides = 0;
    let revenueToday = 0;
    const daily = [];

    for (let offset = 6; offset >= 0; offset -= 1) {
      const start = startToday - (offset * 24 * 60 * 60 * 1000);
      daily.push({ date: new Date(start).toISOString().slice(0, 10), rides: 0, completed: 0, cancelled: 0, revenue: 0 });
    }

    rides.forEach((ride) => {
      const timestamp = Number(ride.createdAt || ride.acceptedAt || ride.updatedAt || 0);
      if (['SEARCHING', 'ACCEPTED', 'IN_PROGRESS'].includes(ride.status)) activeRides += 1;
      if (timestamp >= startToday) {
        ridesToday += 1;
        if (ride.status === 'COMPLETED') {
          completedToday += 1;
          revenueToday += Number(ride.price) || 0;
        }
        if (ride.status === 'CANCELLED') cancelledToday += 1;
      }
      if (timestamp >= start7Days) {
        const key = new Date(timestamp).toISOString().slice(0, 10);
        const bucket = daily.find((item) => item.date === key);
        if (bucket) {
          bucket.rides += 1;
          if (ride.status === 'COMPLETED') {
            bucket.completed += 1;
            bucket.revenue += Number(ride.price) || 0;
          }
          if (ride.status === 'CANCELLED') bucket.cancelled += 1;
        }
      }
    });

    return res.json({
      success: true,
      totals: {
        passengers,
        drivers,
        approvedDrivers,
        onlineDrivers,
        ridesToday,
        activeRides,
        completedToday,
        cancelledToday,
        revenueToday: Number(revenueToday.toFixed(2))
      },
      daily
    });
  } catch (error) {
    console.error('Erro nas estatísticas administrativas:', error);
    return res.status(500).json({ error: 'Erro ao carregar estatísticas administrativas.' });
  }
});

module.exports = router;
