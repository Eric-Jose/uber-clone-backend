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
    req.adminUser = user;
    next();
  } catch (error) {
    return res.status(500).json({ error: 'Não foi possível validar o administrador.' });
  }
}

router.post('/register', async (req, res) => {
  try {
    const uid = req.user.uid;
    const data = req.body || {};
    const required = ['fullName', 'email', 'phone', 'cpf', 'driverLicense', 'licensePlate', 'vehicleModel', 'vehicleColor', 'vehicleYear', 'address', 'city', 'state'];
    const missing = required.filter((field) => data[field] === undefined || data[field] === null || String(data[field]).trim() === '');
    if (missing.length) return res.status(400).json({ error: `Preencha os campos obrigatórios: ${missing.join(', ')}` });

    const vehicleYear = Number(data.vehicleYear);
    if (!Number.isInteger(vehicleYear) || vehicleYear < 2010 || vehicleYear > new Date().getFullYear()) return res.status(400).json({ error: 'Ano do veículo inválido.' });

    const documents = Array.isArray(data.documents) ? data.documents.slice(0, 10).map((doc) => ({
      name: String(doc?.name || '').slice(0, 150), type: String(doc?.type || '').slice(0, 100), size: Math.max(0, Number(doc?.size) || 0)
    })) : [];
    if (documents.length < 3) return res.status(400).json({ error: 'Envie pelo menos 3 documentos.' });

    const existingSnapshot = await db.ref(`users/${uid}`).get();
    const existingUser = existingSnapshot.val();
    if (!existingUser) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (existingUser.driverApprovalStatus === 'approved') return res.status(409).json({ error: 'Este motorista já está aprovado.' });

    const submittedAt = new Date().toISOString();
    const application = {
      uid,
      fullName: String(data.fullName).trim().slice(0, 120), email: String(data.email).trim().toLowerCase().slice(0, 160),
      phone: String(data.phone).trim().slice(0, 30), cpf: String(data.cpf).trim().slice(0, 20), driverLicense: String(data.driverLicense).trim().slice(0, 30),
      licensePlate: String(data.licensePlate).trim().toUpperCase().slice(0, 10), vehicleModel: String(data.vehicleModel).trim().slice(0, 80),
      vehicleColor: String(data.vehicleColor).trim().slice(0, 40), vehicleYear, address: String(data.address).trim().slice(0, 180),
      city: String(data.city).trim().slice(0, 80), state: String(data.state).trim().toUpperCase().slice(0, 2), documents,
      status: 'pending', submittedAt
    };

    await db.ref(`driverApplications/${uid}`).set(application);
    await db.ref(`users/${uid}`).update({
      userType: 'driver', driverApprovalStatus: 'pending', isOnline: false,
      driverProfile: { fullName: application.fullName, phone: application.phone, cpf: application.cpf, driverLicense: application.driverLicense,
        vehicle: { licensePlate: application.licensePlate, model: application.vehicleModel, color: application.vehicleColor, year: application.vehicleYear },
        address: { address: application.address, city: application.city, state: application.state } }
    });

    return res.status(201).json({ success: true, application: { uid, status: 'pending', submittedAt, documentCount: documents.length } });
  } catch (error) {
    console.error('Erro ao registrar motorista:', error);
    return res.status(500).json({ error: 'Erro ao enviar cadastro de motorista.' });
  }
});

// Lista de solicitações para o painel administrativo.
router.get('/applications', requireAdmin, async (req, res) => {
  try {
    const snapshot = await db.ref('driverApplications').get();
    const applications = [];
    snapshot.forEach((child) => {
      const application = child.val() || {};
      applications.push({ ...application, uid: child.key, documentCount: Array.isArray(application.documents) ? application.documents.length : 0 });
    });
    applications.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
    return res.json({ total: applications.length, pending: applications.filter((item) => item.status === 'pending').length, applications });
  } catch (error) {
    console.error('Erro ao listar solicitações:', error);
    return res.status(500).json({ error: 'Erro ao listar solicitações de motoristas.' });
  }
});

router.patch('/:driverId/approval', requireAdmin, async (req, res) => {
  try {
    const { driverId } = req.params;
    const status = String(req.body?.status || '').toLowerCase();
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Status deve ser approved ou rejected.' });

    const applicationSnap = await db.ref(`driverApplications/${driverId}`).get();
    if (!applicationSnap.exists()) return res.status(404).json({ error: 'Solicitação de motorista não encontrada.' });
    const application = applicationSnap.val();
    const now = new Date().toISOString();

    await db.ref(`driverApplications/${driverId}`).update({ status, reviewedAt: now, reviewedBy: req.user.uid });
    await db.ref(`users/${driverId}`).update({
      userType: 'driver', driverApprovalStatus: status, isOnline: false,
      driverApprovalReviewedAt: now, driverApprovalReviewedBy: req.user.uid
    });

    return res.json({ success: true, uid: driverId, status, reviewedAt: now, name: application.fullName || '' });
  } catch (error) {
    console.error('Erro ao revisar motorista:', error);
    return res.status(500).json({ error: 'Erro ao atualizar aprovação do motorista.' });
  }
});

router.get('/available', async (req, res) => {
  try {
    const lat = Number(req.query.lat), lng = Number(req.query.lng), radius = Number(req.query.radius ?? 5);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius) || radius <= 0) return res.status(400).json({ error: 'Latitude, longitude e raio válidos são obrigatórios.' });
    const driversSnapshot = await db.ref('users').orderByChild('userType').equalTo('driver').get();
    const drivers = [];
    driversSnapshot.forEach((childSnapshot) => {
      const driver = childSnapshot.val();
      if (driver.driverApprovalStatus !== 'approved' || !driver.isOnline || !driver.currentLocation) return;
      const driverLat = Number(driver.currentLocation.lat ?? driver.currentLocation.latitude), driverLng = Number(driver.currentLocation.lng ?? driver.currentLocation.longitude);
      if (!Number.isFinite(driverLat) || !Number.isFinite(driverLng)) return;
      const distance = calculateDistance(lat, lng, driverLat, driverLng);
      if (distance <= radius) drivers.push({ ...driver, uid: childSnapshot.key, distance: Number(distance.toFixed(2)) });
    });
    drivers.sort((a, b) => a.distance - b.distance);
    return res.json({ total: drivers.length, drivers });
  } catch (error) { console.error('Erro ao listar motoristas:', error); return res.status(500).json({ error: 'Erro ao listar motoristas.' }); }
});

router.post('/:driverId/status', async (req, res) => {
  try {
    const { driverId } = req.params, { isOnline, currentLocation } = req.body;
    if (driverId !== req.user.uid) return res.status(403).json({ error: 'Você só pode alterar o próprio status.' });
    if (typeof isOnline !== 'boolean') return res.status(400).json({ error: 'isOnline deve ser booleano.' });
    const driverSnapshot = await db.ref(`users/${driverId}`).get(), driver = driverSnapshot.val();
    if (!driver || driver.userType !== 'driver') return res.status(403).json({ error: 'Usuário não é motorista.' });
    if (isOnline && driver.driverApprovalStatus !== 'approved') return res.status(403).json({ error: 'Seu cadastro de motorista ainda não foi aprovado.' });

    const update = { isOnline, lastLocationUpdate: new Date().toISOString() };
    if (currentLocation !== undefined) {
      const lat = Number(currentLocation.lat ?? currentLocation.latitude), lng = Number(currentLocation.lng ?? currentLocation.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'Localização inválida.' });
      update.currentLocation = { lat, lng };
      await db.ref(`locations/${driverId}`).set({ lat, lng, latitude: lat, longitude: lng, timestamp: new Date().toISOString() });
    }
    await db.ref(`users/${driverId}`).update(update);
    return res.json({ message: 'Status atualizado', isOnline });
  } catch (error) { console.error('Erro ao atualizar status:', error); return res.status(500).json({ error: 'Erro ao atualizar status.' }); }
});

router.get('/:driverId', async (req, res) => {
  try {
    const driverSnapshot = await db.ref(`users/${req.params.driverId}`).get(), driver = driverSnapshot.val();
    if (!driver) return res.status(404).json({ error: 'Motorista não encontrado' });
    return res.json(driver);
  } catch (error) { return res.status(500).json({ error: 'Erro ao buscar motorista.' }); }
});

router.post('/:driverId/rating', async (req, res) => {
  try {
    const { driverId } = req.params, rating = Number(req.body.rating);
    const comment = typeof req.body.comment === 'string' ? req.body.comment.trim().slice(0, 500) : '';
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Avaliação deve ser entre 1 e 5' });
    if (driverId === req.user.uid) return res.status(403).json({ error: 'Motorista não pode avaliar a si mesmo.' });
    const driverSnapshot = await db.ref(`users/${driverId}`).get();
    if (!driverSnapshot.exists() || driverSnapshot.val().userType !== 'driver') return res.status(404).json({ error: 'Motorista não encontrado.' });
    await db.ref(`ratings/${driverId}`).push({ rating, comment, passengerId: req.user.uid, createdAt: new Date().toISOString() });
    const ratingsSnapshot = await db.ref(`ratings/${driverId}`).get(); let totalRating = 0; let count = 0;
    ratingsSnapshot.forEach((childSnapshot) => { const value = childSnapshot.val(); totalRating += Number(value.rating) || 0; count++; });
    const avgRating = count ? Number((totalRating / count).toFixed(1)) : 0;
    await db.ref(`users/${driverId}`).update({ rating: avgRating });
    return res.json({ message: 'Avaliação registrada', rating: avgRating });
  } catch (error) { console.error('Erro ao registrar avaliação:', error); return res.status(500).json({ error: 'Erro ao registrar avaliação.' }); }
});

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = router;
