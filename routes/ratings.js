const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const { authenticate } = require('../middleware/auth');

const db = admin.database();
router.use(authenticate);

router.post('/', async (req, res) => {
  try {
    const { rideId, rating, comment } = req.body;
    const uid = req.user.uid;
    const score = Number(rating);

    if (!rideId) return res.status(400).json({ error: 'ID da corrida é obrigatório.' });
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return res.status(400).json({ error: 'A avaliação deve ser um número inteiro de 1 a 5.' });
    }

    const rideSnapshot = await db.ref(`rides/${rideId}`).get();
    const ride = rideSnapshot.val();
    if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' });
    if (ride.status !== 'COMPLETED') return res.status(409).json({ error: 'Somente corridas concluídas podem ser avaliadas.' });
    if (ride.userId !== uid && ride.driverId !== uid) return res.status(403).json({ error: 'Você não pertence a esta corrida.' });
    if (!ride.driverId) return res.status(409).json({ error: 'Esta corrida não possui motorista para avaliação.' });

    const targetId = ride.userId === uid ? ride.driverId : ride.userId;
    const markerRef = db.ref(`ratingClaims/${rideId}/${uid}`);
    const claim = await markerRef.transaction(current => current || { rating: score, claimedAt: admin.database.ServerValue.TIMESTAMP });
    if (!claim.committed) return res.status(409).json({ error: 'Não foi possível registrar a avaliação.' });
    if (claim.snapshot.val()?.rating !== score) return res.status(409).json({ error: 'Você já avaliou esta corrida.' });

    const ratingsSnapshot = await db.ref('ratings').orderByChild('rideId').equalTo(rideId).get();
    let existingRating = null;
    ratingsSnapshot.forEach(child => {
      if (child.val()?.raterId === uid) existingRating = child.val();
    });
    if (existingRating) return res.status(409).json({ error: 'Você já avaliou esta corrida.' });

    const ratingRef = db.ref('ratings').push();
    const ratingData = {
      id: ratingRef.key,
      rideId,
      raterId: uid,
      targetId,
      rating: score,
      comment: typeof comment === 'string' ? comment.trim().slice(0, 500) : '',
      createdAt: admin.database.ServerValue.TIMESTAMP
    };

    await ratingRef.set(ratingData);

    const targetRef = db.ref(`users/${targetId}`);
    await targetRef.child('ratingCount').transaction(current => (Number(current) || 0) + 1);
    await targetRef.child('ratingSum').transaction(current => (Number(current) || 0) + score);
    const aggregate = await targetRef.get();
    const profile = aggregate.val() || {};
    const count = Number(profile.ratingCount) || 0;
    const sum = Number(profile.ratingSum) || 0;
    if (count > 0) {
      await targetRef.child('ratingAverage').set(Number((sum / count).toFixed(2)));
    }

    return res.status(201).json({ success: true, rating: ratingData, aggregate: { ratingCount: count, ratingAverage: count ? Number((sum / count).toFixed(2)) : 0 } });
  } catch (error) {
    console.error('Erro ao registrar avaliação:', error);
    return res.status(500).json({ error: 'Erro interno ao registrar avaliação.' });
  }
});

router.get('/ride/:rideId', async (req, res) => {
  try {
    const rideSnapshot = await db.ref(`rides/${req.params.rideId}`).get();
    const ride = rideSnapshot.val();
    if (!ride) return res.status(404).json({ error: 'Corrida não encontrada.' });
    if (ride.userId !== req.user.uid && ride.driverId !== req.user.uid) return res.status(403).json({ error: 'Acesso negado.' });

    const snapshot = await db.ref('ratings').orderByChild('rideId').equalTo(req.params.rideId).get();
    const ratings = [];
    snapshot.forEach(child => ratings.push(child.val()));
    return res.json({ success: true, ratings });
  } catch (error) {
    console.error('Erro ao buscar avaliações:', error);
    return res.status(500).json({ error: 'Erro interno ao buscar avaliações.' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const snapshot = await db.ref(`users/${req.user.uid}`).get();
    const user = snapshot.val() || {};
    const ratingCount = Number(user.ratingCount) || 0;
    const ratingSum = Number(user.ratingSum) || 0;
    return res.json({ success: true, ratingCount, ratingAverage: ratingCount ? Number((ratingSum / ratingCount).toFixed(2)) : 0 });
  } catch (error) {
    console.error('Erro ao buscar resumo de avaliações:', error);
    return res.status(500).json({ error: 'Erro interno ao buscar resumo de avaliações.' });
  }
});

module.exports = router;
