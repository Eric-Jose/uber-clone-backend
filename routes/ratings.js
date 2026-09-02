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

    const ratingsSnapshot = await db.ref('ratings').orderByChild('rideId').equalTo(rideId).get();
    let alreadyRated = false;
    ratingsSnapshot.forEach(child => {
      if (child.val()?.raterId === uid) alreadyRated = true;
    });
    if (alreadyRated) return res.status(409).json({ error: 'Você já avaliou esta corrida.' });

    const targetId = ride.userId === uid ? ride.driverId : ride.userId;
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
    return res.status(201).json({ success: true, rating: ratingData });
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

module.exports = router;
