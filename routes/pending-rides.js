const express = require('express');
const admin = require('firebase-admin');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const db = admin.database();
const DISPATCH_RADIUS_KM = Math.max(1, Number(process.env.DISPATCH_RADIUS_KM) || 25);
const DISPATCH_RADIUS_EXTENDED_KM = Math.max(DISPATCH_RADIUS_KM, Number(process.env.DISPATCH_RADIUS_EXTENDED_KM) || 50);
const DISPATCH_RADIUS_LONG_KM = Math.max(DISPATCH_RADIUS_EXTENDED_KM, Number(process.env.DISPATCH_RADIUS_LONG_KM) || 100);
router.use(authenticate);

function normalizeLocation(value) {
  const source = value?.location || value?.currentLocation || value || {};
  const lat = Number(source.lat ?? source.latitude);
  const lng = Number(source.lng ?? source.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function distanceKm(a, b) {
  const lat1 = Number(a?.lat ?? a?.latitude), lon1 = Number(a?.lng ?? a?.longitude);
  const lat2 = Number(b?.lat ?? b?.latitude), lon2 = Number(b?.lng ?? b?.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function dispatchRadiusKm(ageMs) {
  if (ageMs < 60 * 1000) return DISPATCH_RADIUS_KM;
  if (ageMs < 5 * 60 * 1000) return DISPATCH_RADIUS_EXTENDED_KM;
  return DISPATCH_RADIUS_LONG_KM;
}

router.get('/', async (req, res) => {
  try {
    const driverId = req.user.uid;
    const driverSnapshot = await db.ref(`users/${driverId}`).get();
    const driver = driverSnapshot.val();

    if (!driver || driver.userType !== 'driver') return res.status(403).json({ error: 'Somente motoristas podem consultar pedidos.' });
    if (driver.driverApprovalStatus !== 'approved') return res.status(403).json({ error: 'Motorista ainda não foi aprovado.' });
    if (driver.isOnline !== true) return res.json({ success: true, rides: [] });

    const driverLocation = normalizeLocation(driver.currentLocation);
    if (!driverLocation) return res.json({ success: true, rides: [] });

    const ridesSnapshot = await db.ref('rides').get();
    const rides = [];
    const now = Date.now();

    ridesSnapshot.forEach(child => {
      const ride = child.val();
      if (!ride || ride.status !== 'SEARCHING' || ride.driverId) return;
      const createdAt = Number(ride.createdAt || 0);
      const ageMs = createdAt > 0 ? Math.max(0, now - createdAt) : 0;
      if (createdAt > 0 && ageMs > 10 * 60 * 1000) return;
      const origin = normalizeLocation(ride.origin);
      const distance = distanceKm(driverLocation, origin);
      const radiusKm = dispatchRadiusKm(ageMs);
      if (!Number.isFinite(distance) || distance > radiusKm) return;
      rides.push({ ...ride, estimatedDistanceKm: Number(distance.toFixed(2)), dispatchRadiusKm: radiusKm, dispatchRank: 1 });
    });

    rides.sort((a, b) => Number(a.estimatedDistanceKm) - Number(b.estimatedDistanceKm) || Number(a.createdAt || 0) - Number(b.createdAt || 0));
    return res.json({ success: true, rides: rides.slice(0, 20) });
  } catch (error) {
    console.error('Erro ao buscar pedidos pendentes:', error);
    return res.status(500).json({ error: 'Erro ao buscar pedidos pendentes.' });
  }
});

module.exports = router;
