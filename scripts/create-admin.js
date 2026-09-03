require('dotenv').config();
const crypto = require('crypto');
const admin = require('firebase-admin');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} não configurado.`);
  return value;
}

function initFirebase() {
  if (admin.apps.length) return;
  const privateKey = required('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n');
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: required('FIREBASE_PROJECT_ID'),
      privateKey,
      clientEmail: required('FIREBASE_CLIENT_EMAIL')
    }),
    databaseURL: required('FIREBASE_DATABASE_URL')
  });
}

function generatePassword() {
  return `Adm!${crypto.randomBytes(9).toString('base64url')}9#`;
}

async function main() {
  const email = required('ADMIN_EMAIL').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || generatePassword();
  const name = process.env.ADMIN_NAME || 'Administrador';

  if (!email.includes('@')) throw new Error('ADMIN_EMAIL inválido.');
  if (password.length < 12) throw new Error('ADMIN_PASSWORD deve ter pelo menos 12 caracteres.');

  initFirebase();
  const auth = admin.auth();
  const db = admin.database();

  let user;
  try {
    user = await auth.getUserByEmail(email);
    await auth.updateUser(user.uid, { password, displayName: name, disabled: false });
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    user = await auth.createUser({ email, password, displayName: name, emailVerified: false });
  }

  const userRef = db.ref(`users/${user.uid}`);
  const snapshot = await userRef.get();
  const existing = snapshot.val() || {};
  const userData = {
    ...existing,
    uid: user.uid,
    email,
    name,
    userType: 'admin',
    role: 'admin',
    isOnline: false,
    updatedAt: new Date().toISOString(),
    ...(existing.createdAt ? {} : { createdAt: new Date().toISOString() })
  };

  // Atualiza somente o registro do administrador; nunca substitui a coleção /users inteira.
  await userRef.update(userData);

  console.log('\nADMINISTRADOR CONFIGURADO COM SUCESSO');
  console.log(`Email: ${email}`);
  console.log(`Senha temporária: ${password}`);
  console.log(`UID: ${user.uid}`);
  console.log('\nIMPORTANTE: troque a senha após o primeiro acesso e não salve esta saída em repositórios ou chats públicos.');
}

main().catch(error => {
  console.error(`Erro ao configurar administrador: ${error.message}`);
  process.exit(1);
});
