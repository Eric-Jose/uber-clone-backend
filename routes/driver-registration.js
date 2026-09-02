const express = require('express');
const admin = require('firebase-admin');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
const db = admin.database();

router.use(authenticate);

// Envia/atualiza a ficha do motorista. Arquivos não são armazenados neste endpoint;
// apenas os metadados são registrados para que o upload seguro possa ser integrado depois.
router.post('/', async (req, res) => {
  try {
    const uid = req.user.uid;
    const body = req.body || {};
    const required = ['fullName', 'email', 'phone', 'cpf', 'driverLicense', 'licensePlate', 'vehicleModel', 'vehicleColor', 'vehicleYear', 'address', 'city', 'state'];

    for (const field of required) {
      if (body[field] === undefined || String(body[field]).trim() === '') {
        return res.status(400).json({ error: `Campo obrigatório: ${field}` });
      }
    }

    const year = Number(body.vehicleYear);
    if (!Number.isInteger(year) || year < 2010 || year > new Date().getFullYear()) {
      return res.status(400).json({ error: 'Ano do veículo inválido.' });
    }

    const documents = Array.isArray(body.documents) ? body.documents.slice(0, 10).map((doc) => ({
      name: String(doc?.name || '').slice(0, 160),
      type: String(doc?.type || '').slice(0, 80),
      size: Number(doc?.size) || 0
    })).filter((doc) => doc.name) : [];

    if (documents.length < 3) {
      return res.status(400).json({ error: 'Envie pelo menos 3 documentos.' });
    }

    const userSnapshot = await db.ref(`users/${uid}`).get();
    const user = userSnapshot.val();
    if (!user || user.userType !== 'driver') {
      return res.status(403).json({ error: 'A conta precisa estar cadastrada como motorista.' });
    }

    const registration = {
      uid,
      fullName: String(body.fullName).trim().slice(0, 120),
      email: String(body.email).trim().slice(0, 160),
      phone: String(body.phone).trim().slice(0, 40),
      cpf: String(body.cpf).trim().slice(0, 20),
      driverLicense: String(body.driverLicense).trim().slice(0, 40),
      vehicle: {
        licensePlate: String(body.licensePlate).trim().toUpperCase().slice(0, 12),
        model: String(body.vehicleModel).trim().slice(0, 80),
        color: String(body.vehicleColor).trim().slice(0, 40),
        year
      },
      address: {
        address: String(body.address).trim().slice(0, 200),
        city: String(body.city).trim().slice(0, 80),
        state: String(body.state).trim().toUpperCase().slice(0, 2)
      },
      bank: {
        bankName: String(body.bankName || '').trim().slice(0, 100),
        bankDataProvided: Boolean(body.bankName && body.bankAccount && body.bankRoutingNumber)
      },
      documents,
      status: 'pending',
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await db.ref(`driverRegistrations/${uid}`).set(registration);
    await db.ref(`users/${uid}`).update({ driverRegistrationStatus: 'pending', driverRegistrationSubmittedAt: registration.submittedAt });

    return res.status(201).json({
      success: true,
      message: 'Cadastro de motorista enviado. Aguarde a aprovação.',
      registration: { uid, status: registration.status, submittedAt: registration.submittedAt }
    });
  } catch (error) {
    console.error('Erro no cadastro de motorista:', error);
    return res.status(500).json({ error: 'Erro interno ao enviar cadastro.' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const snapshot = await db.ref(`driverRegistrations/${req.user.uid}`).get();
    if (!snapshot.exists()) return res.status(404).json({ error: 'Cadastro de motorista não encontrado.' });
    return res.json({ success: true, registration: snapshot.val() });
  } catch (error) {
    return res.status(500).json({ error: 'Erro ao consultar cadastro.' });
  }
});

module.exports = router;
