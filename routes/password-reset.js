const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const router = express.Router();
const auth = admin.auth();

// Envia o e-mail de recuperação usando o fluxo oficial do Firebase Authentication.
router.post('/request', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Informe seu email.' });
    if (!process.env.FIREBASE_WEB_API_KEY) return res.status(500).json({ error: 'FIREBASE_WEB_API_KEY não configurada no servidor.' });

    await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${process.env.FIREBASE_WEB_API_KEY}`,
      { requestType: 'PASSWORD_RESET', email },
      { timeout: 10000 }
    );

    return res.json({ message: 'Se esse email estiver cadastrado, enviamos um link para redefinir sua senha.' });
  } catch (error) {
    // Não revela se o email existe, evitando exposição de contas cadastradas.
    console.error('Solicitação de recuperação:', error.response?.data || error.message);
    return res.json({ message: 'Se esse email estiver cadastrado, enviamos um link para redefinir sua senha.' });
  }
});

// Confirma a troca da senha com o código recebido no e-mail.
router.post('/confirm', async (req, res) => {
  try {
    const oobCode = String(req.body?.oobCode || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    if (!oobCode || !newPassword) return res.status(400).json({ error: 'Código e nova senha são obrigatórios.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres.' });

    await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=${process.env.FIREBASE_WEB_API_KEY}`,
      { oobCode, newPassword },
      { timeout: 10000 }
    );

    return res.json({ message: 'Senha alterada com sucesso. Agora você já pode entrar.' });
  } catch (error) {
    console.error('Confirmação de recuperação:', error.response?.data || error.message);
    return res.status(400).json({ error: 'O link de recuperação é inválido, expirou ou a senha não atende aos requisitos.' });
  }
});

module.exports = router;
