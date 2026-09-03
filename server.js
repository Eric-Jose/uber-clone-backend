const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const admin = require('firebase-admin');
const http = require('http');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');

const authRoutes = require('./routes/auth');
const driverRoutes = require('./routes/drivers');
const rideRoutes = require('./routes/rides');
const locationRoutes = require('./routes/location');
const ratingRoutes = require('./routes/ratings');

dotenv.config();

const app = express();
const server = http.createServer(app);
const allowedOrigins = [
  'https://uber-clone-web.vercel.app',
  'https://uber-clone-web-eric-jose.vercel.app',
  'https://uber-clone-web-git-main-eric-jose.vercel.app',
  'https://uber-clone-eric.vercel.app',
  'http://localhost:3000'
];
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Bloqueado pelo CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

const io = socketIo(server, { cors: { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true } });

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = admin.database();