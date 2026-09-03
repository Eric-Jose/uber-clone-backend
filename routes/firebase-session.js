const express = require('express');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');

const router = express.Router();
const db = admin.database();
const auth = admin.auth();

function createToken(uid, email) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET não configurado');
  return jwt.sign({ uid, email }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

async function normalizeUser(userData, uid) {
  const normalizedUser = { ...(userData || {}) };
  if (normalizedUser.userType === 'driver') {
    const mirroredApplication = normalizedUser.driverApplication || {};
    const recoveredStatus = normalizedUser.driverApprovalStatus || mirroredApplication.status || (normalizedUser.driverProfile ? 'pending' : null);
    if (recoveredStatus && normalizedUser.driverApprovalStatus !== recoveredStatus) {
      normalizedUser.driverApprovalStatus = recoveredStatus;
      await db.ref(`users/${uid}`).update({ driverApprovalStatus: recoveredStatus });
    }
  }
  return normalizedUser;
}

router.post('/', async (req, res) => {
  try {
    const idToken = String(req.body?.idToken || '').trim();
    if (!idToken) return res.status(400).json({ error: 'idToken é obrigatório.' });

    const decoded = await auth.verifyIdToken(idToken, true);
    const uid = decoded.uid;
    const email = String(decoded.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'A conta Firebase não possui email válido.' });

    const userSnapshot = await db.ref(`users/${uid}`).get();
    if (!userSnapshot.exists()) return res.status(404).json({ error: 'Perfil do usuário não encontrado.' });

    const user = await normalizeUser(userSnapshot.val(), uid);
    const token = createToken(uid, email);
    return res.json({ success: true, token, user });
  } catch (error) {
    console.error('Erro ao sincronizar sessão Firebase:', error.message);
    if (error?.code === 'auth/id-token-expired' || error?.code === 'auth/id-token-revoked' || error?.code === 'auth/argument-error') {
      return res.status(401).json({ error: 'Sessão Firebase inválida ou expirada.' });
    }
    return res.status(401).json({ error: 'Não foi possível sincronizar a sessão.' });
  }
});

module.exports = router;
