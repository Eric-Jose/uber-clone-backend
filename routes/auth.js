const express = require('express');
const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();

const db = admin.database();
const auth = admin.auth();

// Registro de novo usuário
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, phone, userType } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, senha e nome são obrigatórios' });
    }

    // Criar usuário no Firebase Auth
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: name
    });

    // Salvar dados adicionais no Realtime Database
    await db.ref(`users/${userRecord.uid}`).set({
      uid: userRecord.uid,
      email,
      name,
      phone,
      userType, // 'passenger' ou 'driver'
      createdAt: new Date().toISOString(),
      rating: 5.0,
      totalRides: 0,
      isOnline: false
    });

    const token = jwt.sign(
      { uid: userRecord.uid, email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Usuário registrado com sucesso',
      uid: userRecord.uid,
      token
    });
  } catch (error) {
    console.error('Erro ao registrar:', error);
    res.status(400).json({ error: error.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }

    // Buscar usuário
    const userRecord = await auth.getUserByEmail(email);

    // Buscar dados do usuário no database
    const userSnapshot = await db.ref(`users/${userRecord.uid}`).get();
    const userData = userSnapshot.val();

    if (!userData) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    // Gerar token JWT
    const token = jwt.sign(
      { uid: userRecord.uid, email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login realizado com sucesso',
      token,
      user: userData
    });
  } catch (error) {
    console.error('Erro ao fazer login:', error);
    res.status(401).json({ error: 'Email ou senha inválidos' });
  }
});

// Verificar token
router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userSnapshot = await db.ref(`users/${decoded.uid}`).get();
    const userData = userSnapshot.val();

    res.json({
      valid: true,
      user: userData
    });
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
});

module.exports = router;
