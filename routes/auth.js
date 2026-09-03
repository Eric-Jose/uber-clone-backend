const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const router = express.Router();

const db = admin.database();
const auth = admin.auth();

const DEFAULT_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@uberclone.com';
const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'UberClone@2026!';
const DEFAULT_ADMIN_NAME = process.env.ADMIN_NAME || 'Administrador';

function createToken(uid, email) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET não configurado');
  return jwt.sign({ uid, email }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

async function firebasePasswordLogin(email, password) {
  if (!process.env.FIREBASE_WEB_API_KEY) throw new Error('FIREBASE_WEB_API_KEY não configurada no servidor');
  const response = await axios.post(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FIREBASE_WEB_API_KEY}`,
    { email, password, returnSecureToken: true },
    { timeout: 10000 }
  );
  return response.data;
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, name, phone, userType = 'passenger' } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'Email, senha e nome são obrigatórios' });
    if (password.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    if (!['passenger', 'driver'].includes(userType)) return res.status(400).json({ error: 'Tipo de usuário inválido' });
    const userRecord = await auth.createUser({ email, password, displayName: name });
    const userData = { uid: userRecord.uid, email, name, phone: phone || '', userType, createdAt: new Date().toISOString(), rating: 5.0, totalRides: 0, isOnline: false };
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
    const firebaseResponse = await firebasePasswordLogin(email, password);
    const uid = firebaseResponse.localId;
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

router.post('/admin-login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });

    let userRecord;
    try {
      userRecord = await auth.getUserByEmail(email);
      if (userRecord.disabled) userRecord = await auth.updateUser(userRecord.uid, { disabled: false });
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
      if (email !== DEFAULT_ADMIN_EMAIL.toLowerCase() || password !== DEFAULT_ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Credenciais administrativas inválidas' });
      }
      userRecord = await auth.createUser({ email, password, displayName: DEFAULT_ADMIN_NAME });
    }

    const userRef = db.ref(`users/${userRecord.uid}`);
    const snapshot = await userRef.get();
    const existing = snapshot.val() || {};
    const isAdmin = existing.userType === 'admin' || existing.role === 'admin';
    if (!isAdmin && email !== DEFAULT_ADMIN_EMAIL.toLowerCase()) {
      return res.status(403).json({ error: 'Este usuário não é administrador' });
    }

    if (snapshot.exists()) {
      try {
        await firebasePasswordLogin(email, password);
      } catch (error) {
        if (email === DEFAULT_ADMIN_EMAIL.toLowerCase() && password === DEFAULT_ADMIN_PASSWORD) {
          userRecord = await auth.updateUser(userRecord.uid, { password: DEFAULT_ADMIN_PASSWORD, disabled: false });
        } else {
          return res.status(401).json({ error: 'Email ou senha inválidos' });
        }
      }
    }

    const adminData = {
      ...existing,
      uid: userRecord.uid,
      email,
      name: existing.name || DEFAULT_ADMIN_NAME,
      userType: 'admin',
      role: 'admin',
      isOnline: false,
      updatedAt: new Date().toISOString(),
      ...(existing.createdAt ? {} : { createdAt: new Date().toISOString() })
    };
    await userRef.set(adminData);
    const token = createToken(userRecord.uid, email);
    return res.json({ message: 'Login administrativo realizado com sucesso', token, admin: adminData, requiresTwoFA: false });
  } catch (error) {
    console.error('Erro no login administrativo:', error);
    return res.status(500).json({ error: 'Não foi possível entrar como administrador' });
  }
});

// Allows an already authenticated administrator to replace the password without
// requiring the old password. The JWT is verified and the database profile must
// still have admin privileges, so this cannot be used by ordinary users.
router.post('/admin/set-password', async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userSnapshot = await db.ref(`users/${decoded.uid}`).get();
    const userData = userSnapshot.val();
    if (!userData || (userData.userType !== 'admin' && userData.role !== 'admin')) {
      return res.status(403).json({ error: 'Acesso administrativo negado' });
    }

    const newPassword = String(req.body?.newPassword || '');
    if (!newPassword) return res.status(400).json({ error: 'Informe a nova senha' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 8 caracteres' });

    await auth.updateUser(decoded.uid, { password: newPassword, disabled: false });
    return res.json({ message: 'Senha administrativa alterada com sucesso' });
  } catch (error) {
    console.error('Erro ao definir senha administrativa:', error.message);
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    }
    return res.status(400).json({ error: error.message || 'Não foi possível alterar a senha' });
  }
});

router.post('/admin/change-password', async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userSnapshot = await db.ref(`users/${decoded.uid}`).get();
    const userData = userSnapshot.val();
    if (!userData || (userData.userType !== 'admin' && userData.role !== 'admin')) return res.status(403).json({ error: 'Acesso administrativo negado' });

    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Informe a senha atual e a nova senha' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 8 caracteres' });
    if (currentPassword === newPassword) return res.status(400).json({ error: 'A nova senha deve ser diferente da senha atual' });

    await firebasePasswordLogin(userData.email, currentPassword);
    await auth.updateUser(decoded.uid, { password: newPassword });
    return res.json({ message: 'Senha administrativa alterada com sucesso' });
  } catch (error) {
    console.error('Erro ao alterar senha administrativa:', error.response?.data || error.message);
    if (error.response?.data) return res.status(401).json({ error: 'Senha atual inválida' });
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') return res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
    return res.status(400).json({ error: error.message || 'Não foi possível alterar a senha' });
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
