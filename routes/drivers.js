const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

const db = admin.database();
router.use(authenticate);

async function requireAdmin(req, res, next) {
  try {
    const snap = await db.ref(`users/${req.user.uid}`).get();
    const user = snap.val();
    if (!user || user.userType !== 'admin') return res.status(403).json({ error: 'Acesso administrativo necessário.' });
    req.adminUser = user;
    next();
  } catch (error) { return res.status(500).json({ error: 'Não foi possível validar o administrador.' }); }
}

function sanitizeApplication(application = {}) {
  return {
    ...application,
    cpf: application.cpf ? `${String(application.cpf).slice(0,3)}***${String(application.cpf).slice(-2)}` : '',
    driverLicense: application.driverLicense ? `${String(application.driverLicense).slice(0,2)}***${String(application.driverLicense).slice(-2)}` : ''
  };
}

function applicationFromUser(uid, user = {}) {
  const profile = user.driverProfile || {};
  const vehicle = profile.vehicle || {};
  const address = profile.address || {};
  const mirrored = user.driverApplication || {};
  return {
    uid,
    fullName: profile.fullName || user.fullName || user.name || mirrored.fullName || '',
    email: user.email || mirrored.email || '',
    phone: profile.phone || user.phone || mirrored.phone || '',
    cpf: profile.cpf || mirrored.cpf || '',
    driverLicense: profile.driverLicense || mirrored.driverLicense || '',
    licensePlate: vehicle.licensePlate || mirrored.licensePlate || '',
    vehicleModel: vehicle.model || mirrored.vehicleModel || '',
    vehicleColor: vehicle.color || mirrored.vehicleColor || '',
    vehicleYear: vehicle.year || mirrored.vehicleYear || '',
    address: address.address || mirrored.address || '',
    city: address.city || mirrored.city || '',
    state: address.state || mirrored.state || '',
    documents: Array.isArray(mirrored.documents) ? mirrored.documents : [],
    documentCount: Number(mirrored.documentCount || (Array.isArray(mirrored.documents) ? mirrored.documents.length : 0)),
    status: mirrored.status || user.driverApprovalStatus || 'pending',
    submittedAt: mirrored.submittedAt || user.driverRegisteredAt || user.createdAt || null,
    reviewedAt: mirrored.reviewedAt || null,
    reviewedBy: mirrored.reviewedBy || null,
    recoveredFromUser: true
  };
}

router.post('/register', async (req, res) => {
  try {
    const uid = req.user.uid, data = req.body || {};
    const required = ['fullName','email','phone','cpf','driverLicense','licensePlate','vehicleModel','vehicleColor','vehicleYear','address','city','state'];
    const missing = required.filter((field) => data[field] === undefined || data[field] === null || String(data[field]).trim() === '');
    if (missing.length) return res.status(400).json({ error: `Preencha os campos obrigatórios: ${missing.join(', ')}` });
    const vehicleYear = Number(data.vehicleYear);
    if (!Number.isInteger(vehicleYear) || vehicleYear < 2010 || vehicleYear > new Date().getFullYear()) return res.status(400).json({ error: 'Ano do veículo inválido.' });
    const documents = Array.isArray(data.documents) ? data.documents.slice(0,10).map((doc) => ({ name:String(doc?.name || '').slice(0,150), type:String(doc?.type || '').slice(0,100), size:Math.max(0,Number(doc?.size)||0) })) : [];
    if (documents.length < 3) return res.status(400).json({ error: 'Envie pelo menos 3 documentos.' });
    const existingSnapshot = await db.ref(`users/${uid}`).get(), existingUser = existingSnapshot.val();
    if (!existingUser) return res.status(404).json({ error: 'Usuário não encontrado.' });
    if (existingUser.driverApprovalStatus === 'approved') return res.status(409).json({ error: 'Este motorista já está aprovado.' });
    const submittedAt = new Date().toISOString();
    const application = {
      uid, fullName:String(data.fullName).trim().slice(0,120), email:String(data.email).trim().toLowerCase().slice(0,160), phone:String(data.phone).trim().slice(0,30),
      cpf:String(data.cpf).trim().slice(0,20), driverLicense:String(data.driverLicense).trim().slice(0,30), licensePlate:String(data.licensePlate).trim().toUpperCase().slice(0,10),
      vehicleModel:String(data.vehicleModel).trim().slice(0,80), vehicleColor:String(data.vehicleColor).trim().slice(0,40), vehicleYear,
      address:String(data.address).trim().slice(0,180), city:String(data.city).trim().slice(0,80), state:String(data.state).trim().toUpperCase().slice(0,2), documents,
      documentCount: documents.length,
      status:'pending', submittedAt
    };
    await db.ref(`driverApplications/${uid}`).set(application);
    await db.ref(`users/${uid}`).update({ userType:'driver', driverApprovalStatus:'pending', isOnline:false, driverRegisteredAt: existingUser.driverRegisteredAt || submittedAt,
      driverProfile:{ fullName:application.fullName, phone:application.phone, cpf:application.cpf, driverLicense:application.driverLicense,
        vehicle:{ licensePlate:application.licensePlate, model:application.vehicleModel, color:application.vehicleColor, year:application.vehicleYear },
        address:{ address:application.address, city:application.city, state:application.state } },
      driverApplication: application
    });
    return res.status(201).json({ success:true, application:{ uid, status:'pending', submittedAt, documentCount:documents.length } });
  } catch (error) { console.error('Erro ao registrar motorista:', error); return res.status(500).json({ error:'Erro ao enviar cadastro de motorista.' }); }
});

router.get('/applications', requireAdmin, async (req,res) => {
  try {
    const [applicationsSnapshot, usersSnapshot] = await Promise.all([db.ref('driverApplications').get(), db.ref('users').orderByChild('userType').equalTo('driver').get()]);
    const applicationsByUid = new Map();

    applicationsSnapshot.forEach((child) => {
      const application = child.val() || {};
      applicationsByUid.set(child.key, sanitizeApplication(application));
    });

    usersSnapshot.forEach((child) => {
      const user = child.val() || {};
      if (!applicationsByUid.has(child.key)) {
        applicationsByUid.set(child.key, sanitizeApplication(applicationFromUser(child.key, user)));
      }
    });

    const applications = Array.from(applicationsByUid.values());
    applications.sort((a,b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));

    return res.json({ total:applications.length, applications });
  } catch(error){ console.error('Erro ao listar cadastros:',error); return res.status(500).json({error:'Erro ao listar cadastros de motoristas.'}); }
});

router.get('/online-count', requireAdmin, async (req,res) => {
  try {
    const snapshot = await db.ref('users').orderByChild('userType').equalTo('driver').get();
    let online = 0;
    let approved = 0;
    snapshot.forEach((child) => {
      const driver = child.val() || {};
      if (driver.driverApprovalStatus === 'approved') {
        approved += 1;
        if (driver.isOnline === true) online += 1;
      }
    });
    return res.json({ online, approved });
  } catch (error) {
    console.error('Erro ao contar motoristas online:', error);
    return res.status(500).json({ error: 'Erro ao consultar motoristas online.' });
  }
});

router.patch('/:driverId/approval', requireAdmin, async (req,res) => {
  try {
    const {driverId}=req.params, status=String(req.body?.status||'').toLowerCase();
    if(!['pending','approved','rejected'].includes(status)) return res.status(400).json({error:'Status deve ser pending, approved ou rejected.'});
    const userRef=db.ref(`users/${driverId}`), applicationRef=db.ref(`driverApplications/${driverId}`);
    const [userSnapshot,applicationSnapshot]=await Promise.all([userRef.get(),applicationRef.get()]);
    if(!userSnapshot.exists() || userSnapshot.val()?.userType!=='driver') return res.status(404).json({error:'Motorista não encontrado.'});
    const user = userSnapshot.val() || {};
    const existingApplication = applicationSnapshot.exists() ? applicationSnapshot.val() : applicationFromUser(driverId, user);
    const now=new Date().toISOString();
    const approved=status==='approved';
    const updatedApplication={...existingApplication,uid:driverId,status,reviewedAt:status==='pending'?null:now,reviewedBy:status==='pending'?null:req.user.uid,recoveredFromUser:!applicationSnapshot.exists()};
    const userUpdate={driverApprovalStatus:status,isOnline:false,driverApprovedAt:approved?now:null,driverApprovedBy:approved?req.user.uid:null,driverApplication:updatedApplication};
    await Promise.all([userRef.update(userUpdate),applicationRef.set(updatedApplication)]);
    return res.json({success:true,driverId,status,application:updatedApplication});
  } catch(error){ console.error('Erro ao revisar cadastro:',error); return res.status(500).json({error:'Erro ao atualizar aprovação do motorista.'}); }
});

router.get('/available', async (req,res) => {
  try {
    const lat=Number(req.query.lat), lng=Number(req.query.lng), radius=Number(req.query.radius ?? 5);
    if(!Number.isFinite(lat)||!Number.isFinite(lng)||!Number.isFinite(radius)||radius<=0) return res.status(400).json({error:'Latitude, longitude e raio válidos são obrigatórios.'});
    const driversSnapshot=await db.ref('users').orderByChild('userType').equalTo('driver').get(), drivers=[];
    driversSnapshot.forEach((childSnapshot)=>{
      const driver=childSnapshot.val();
      if(driver.driverApprovalStatus!=='approved'||!driver.isOnline||!driver.currentLocation)return;
      const driverLat=Number(driver.currentLocation.lat??driver.currentLocation.latitude),driverLng=Number(driver.currentLocation.lng??driver.currentLocation.longitude);
      if(!Number.isFinite(driverLat)||!Number.isFinite(driverLng))return;
      const distance=calculateDistance(lat,lng,driverLat,driverLng);
      if(distance<=radius) drivers.push({uid:childSnapshot.key,fullName:driver.driverProfile?.fullName||driver.fullName||'Motorista',ratingAverage:Number(driver.ratingAverage??driver.rating??0),ratingCount:Number(driver.ratingCount||0),vehicle:{model:driver.driverProfile?.vehicle?.model||'',color:driver.driverProfile?.vehicle?.color||'',year:driver.driverProfile?.vehicle?.year||null},location:{lat:driverLat,lng:driverLng},distance:Number(distance.toFixed(2))});
    });
    drivers.sort((a,b)=>a.distance-b.distance);
    return res.json({total:drivers.length,drivers});
  } catch(error){console.error('Erro ao listar motoristas:',error);return res.status(500).json({error:'Erro ao listar motoristas.'});}
});

router.get('/me', async (req, res) => {
  try {
    const uid = req.user.uid;
    const snapshot = await db.ref(`users/${uid}`).get();
    const driver = snapshot.val();
    if (!driver || driver.userType !== 'driver') return res.status(403).json({ error: 'Usuário não é motorista.' });
    return res.json({
      success: true,
      driver: {
        uid,
        name: driver.driverProfile?.fullName || driver.fullName || driver.name || driver.email || 'Motorista',
        email: driver.email || '',
        status: driver.driverApprovalStatus || 'pending',
        isOnline: driver.isOnline === true,
        currentLocation: driver.currentLocation || null,
        vehicle: driver.driverProfile?.vehicle || null,
        ratingAverage: Number(driver.ratingAverage ?? driver.rating ?? 0),
        ratingCount: Number(driver.ratingCount || 0)
      }
    });
  } catch (error) {
    console.error('Erro ao buscar motorista atual:', error);
    return res.status(500).json({ error: 'Erro ao buscar dados do motorista.' });
  }
});

router.post('/:driverId/status', async (req,res)=>{
  try{
    const {driverId}=req.params,{isOnline,currentLocation}=req.body;
    if(driverId!==req.user.uid)return res.status(403).json({error:'Você só pode alterar o próprio status.'});
    if(typeof isOnline!=='boolean')return res.status(400).json({error:'isOnline deve ser booleano.'});
    const driverSnapshot=await db.ref(`users/${driverId}`).get(),driver=driverSnapshot.val();
    if(!driver||driver.userType!=='driver')return res.status(403).json({error:'Usuário não é motorista.'});
    if(driver.driverApprovalStatus!=='approved')return res.status(403).json({error:'Seu cadastro de motorista ainda não foi aprovado.'});
    const update={isOnline,lastLocationUpdate:new Date().toISOString()};
    if(currentLocation!==undefined){const lat=Number(currentLocation.lat??currentLocation.latitude),lng=Number(currentLocation.lng??currentLocation.longitude);if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.status(400).json({error:'Localização inválida.'});update.currentLocation={lat,lng};await db.ref(`locations/${driverId}`).set({lat,lng,latitude:lat,longitude:lng,timestamp:new Date().toISOString()});}
    await db.ref(`users/${driverId}`).update(update);return res.json({message:'Status atualizado',isOnline});
  }catch(error){console.error('Erro ao atualizar status:',error);return res.status(500).json({error:'Erro ao atualizar status.'});}
});

router.get('/:driverId', async (req,res)=>{
  try {
    const {driverId}=req.params;
    const driverSnapshot=await db.ref(`users/${driverId}`).get(),driver=driverSnapshot.val();
    if(!driver)return res.status(404).json({error:'Motorista não encontrado'});
    if(driverId===req.user.uid)return res.json(driver);
    const activeRideSnapshot=await db.ref('rides').orderByChild('driverId').equalTo(driverId).get();
    let authorized=false;activeRideSnapshot.forEach((child)=>{const ride=child.val();if(ride?.userId===req.user.uid&&['SEARCHING','ACCEPTED','IN_PROGRESS'].includes(ride.status))authorized=true;});
    if(!authorized)return res.status(403).json({error:'Acesso ao perfil do motorista não autorizado.'});
    return res.json({uid:driverId,fullName:driver.driverProfile?.fullName||driver.fullName||'Motorista',ratingAverage:Number(driver.ratingAverage??driver.rating??0),ratingCount:Number(driver.ratingCount||0),vehicle:{model:driver.driverProfile?.vehicle?.model||'',color:driver.driverProfile?.vehicle?.color||'',year:driver.driverProfile?.vehicle?.year||null},currentLocation:driver.currentLocation||null});
  }catch(error){return res.status(500).json({error:'Erro ao buscar motorista.'});}
});

router.post('/:driverId/rating', async (req,res)=>{
  return res.status(410).json({error:'Endpoint de avaliação antigo. Use POST /api/ratings.'});
});

function calculateDistance(lat1,lon1,lat2,lon2){const R=6371,dLat=(lat2-lat1)*Math.PI/180,dLon=(lon2-lon1)*Math.PI/180;const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));}
module.exports=router;
