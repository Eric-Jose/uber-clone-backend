const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const router = express.Router();

const db = admin.database();
const auth = admin.auth();

function createToken(uid, email) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET não configurado');
  return jwt.sign({ uid, email }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, name, phone, userType = 'passenger' } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Email, senha e nome são obrigatórios' });
    if (password.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    if (!['passenger', 'driver'].includes(userType)) return res.status(400).json({ error: 'Tipo de usuário inválido' });

    const userRecord = await auth.createUser({ email, password, displayName: name });
    const userData = {
      uid: userRecord.uid, email, name, phone: phone || '', userType,
      createdAt: new Date().toISOString(), rating: 5.0, totalRides: 0, isOnline: false
    };
    await db.ref(`users/${userRecord.uid}`).set(userData);
    const token = createToken(userRecord.uid, email);
    return res.status(201).json({ message: 'Usuário registrado com sucesso', uid: userRecord.uid, token, user: userData });
  } catch (error) {
    console.error('Erro ao registrar:', error);
    return res.status(400).json({ error: error.code === 'auth/email-already-exists' ? 'Email já cadastrado' : error.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    if (!process.env.FIREBASE_WEB_API_KEY) return res.status(500).json({ error: 'FIREBASE_WEB_API_KEY não configurada no servidor' });

    const firebaseResponse = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_WEB_API_KEY}`,
      { email, password, returnSecureToken: true },
      { timeout: 10000 }
    );

    const uid = firebaseResponse.data.localId;
    const userSnapshot = await db.ref(`users/${uid}`).get();
    const userData = userSnapshot.val();
    if (!userData) return res.status(404).json({ error: 'Perfil do usuário não encontrado' });

    const token = createToken(uid, email);
    return res.json({ message: 'Login realizado com sucesso', token, user: userData });
  } catch (error) {
    console.error('Erro ao fazer login:', error.response?.data || error.message);
    return res.status(401).json({ error: 'Email ou senha inválidos' });
  }
});

router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userSnapshot = await db.ref(`users/${decoded.uid}`).get();
    const userData = userSnapshot.val();
    if (!userData) return res.status(401).json({ error: 'Usuário não encontrado' });
    return res.json({ valid: true, user: userData });
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }
});

module.exports = router;
