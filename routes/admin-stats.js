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
    if (!user || (user.userType !== 'admin' && user.role !== 'admin')) {
      return res.status(403).json({ error: 'Acesso administrativo necessário.' });
    }
    req.adminUser = user;
    next();
  } catch (error) {
    console.error('Erro ao validar administrador:', error);
    return res.status(500).json({ error: 'Não foi possível validar o administrador.' });
  }
}

router.get('/overview', requireAdmin, async (req, res) => {
  try {
    const [usersSnapshot, ridesSnapshot, applicationsSnapshot] = await Promise.all([
      db.ref('users').get(), db.ref('rides').get(), db.ref('driverApplications').get()
    ]);

    const driversByUid = new Map();
    let passengers = 0;
    usersSnapshot.forEach((child) => {
      const user = child.val() || {};
      if (user.userType === 'passenger') passengers += 1;
      if (user.userType === 'driver') driversByUid.set(child.key, {
        status: user.driverApprovalStatus || user.driverApplication?.status || 'pending',
        isOnline: user.isOnline === true
      });
    });
    applicationsSnapshot.forEach((child) => {
      const application = child.val() || {};
      const current = driversByUid.get(child.key) || {};
      driversByUid.set(child.key, { ...current, status: application.status || current.status || 'pending' });
    });

    let approvedDrivers = 0, pendingDrivers = 0, rejectedDrivers = 0, onlineDrivers = 0;
    for (const driver of driversByUid.values()) {
      if (driver.status === 'approved') {
        approvedDrivers += 1;
        if (driver.isOnline) onlineDrivers += 1;
      } else if (driver.status === 'rejected') rejectedDrivers += 1;
      else pendingDrivers += 1;
    }

    const rides = [];
    ridesSnapshot.forEach((child) => { if (child.val()) rides.push(child.val()); });
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const start7Days = startToday - 6 * 86400000;
    let ridesToday = 0, completedToday = 0, cancelledToday = 0, activeRides = 0, revenueToday = 0;
    const daily = Array.from({ length: 7 }, (_, index) => {
      const start = startToday - (6 - index) * 86400000;
      return { date: new Date(start).toISOString().slice(0, 10), rides: 0, completed: 0, cancelled: 0, revenue: 0 };
    });

    rides.forEach((ride) => {
      const timestamp = Number(ride.createdAt || ride.acceptedAt || ride.updatedAt || 0);
      if (['SEARCHING','ACCEPTED','IN_PROGRESS'].includes(ride.status)) activeRides += 1;
      if (timestamp >= startToday) {
        ridesToday += 1;
        if (ride.status === 'COMPLETED') { completedToday += 1; revenueToday += Number(ride.price) || 0; }
        if (ride.status === 'CANCELLED') cancelledToday += 1;
      }
      if (timestamp >= start7Days) {
        const bucket = daily.find((item) => item.date === new Date(timestamp).toISOString().slice(0, 10));
        if (!bucket) return;
        bucket.rides += 1;
        if (ride.status === 'COMPLETED') { bucket.completed += 1; bucket.revenue += Number(ride.price) || 0; }
        if (ride.status === 'CANCELLED') bucket.cancelled += 1;
      }
    });

    return res.json({
      success: true,
      totals: { passengers, drivers: driversByUid.size, approvedDrivers, pendingDrivers, rejectedDrivers, onlineDrivers, ridesToday, activeRides, completedToday, cancelledToday, revenueToday: Number(revenueToday.toFixed(2)) },
      daily
    });
  } catch (error) {
    console.error('Erro nas estatísticas administrativas:', error);
    return res.status(500).json({ error: 'Erro ao carregar estatísticas administrativas.' });
  }
});

module.exports = router;
