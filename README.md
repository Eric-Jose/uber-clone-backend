# 🚗 UberClone Backend

Servidor backend para o app tipo Uber, construído com Node.js, Express e Firebase.

## 🚀 Funcionalidades

✅ **Autenticação JWT** - Login/Registro seguro  
✅ **Gerencimento de Motoristas** - Listar disponíveis, status online/offline  
✅ **Sistema de Corridas** - Solicitar, aceitar, iniciar e finalizar  
✅ **Localização em Tempo Real** - WebSocket para GPS ao vivo  
✅ **Avaliações e Ratings** - Sistema de feedback dos usuários  
✅ **Histórico de Corridas** - Rastreamento completo  

## 📋 Requisitos

- Node.js v14+
- npm ou yarn
- Firebase Project (conta gratuita)

## 🔧 Instalação

1. **Clone o repositório:**
```bash
git clone https://github.com/Eric-Jose/uber-clone-backend.git
cd uber-clone-backend
```

2. **Instale as dependências:**
```bash
npm install
```

3. **Configure as variáveis de ambiente:**
```bash
cp .env.example .env
# Edite .env com suas credenciais do Firebase
```

4. **Inicie o servidor:**
```bash
npm start      # Produção
npm run dev    # Desenvolvimento com Nodemon
```

## 🌐 API Endpoints

### Autenticação
- `POST /api/auth/register` - Registrar novo usuário
- `POST /api/auth/login` - Fazer login
- `GET /api/auth/verify` - Verificar token

### Motoristas
- `GET /api/drivers/available?lat=X&lng=Y&radius=5` - Listar motoristas próximos
- `POST /api/drivers/:driverId/status` - Atualizar status (online/offline)
- `GET /api/drivers/:driverId` - Obter perfil do motorista
- `POST /api/drivers/:driverId/rating` - Adicionar avaliação

### Corridas
- `POST /api/rides/request` - Solicitar nova corrida
- `POST /api/rides/:rideId/accept` - Motorista aceita corrida
- `POST /api/rides/:rideId/start` - Iniciar corrida
- `POST /api/rides/:rideId/complete` - Finalizar corrida
- `POST /api/rides/:rideId/cancel` - Cancelar corrida
- `GET /api/rides/:rideId` - Obter detalhes da corrida
- `GET /api/rides/user/:userId` - Histórico de corridas

### Localização
- `POST /api/location/update` - Atualizar localização
- `GET /api/location/:userId` - Obter localização atual
- `GET /api/location/:userId/history` - Histórico de localização

## 🔌 WebSocket Events

**Eventos disponíveis:**
- `driver-location` - Motorista envia localização
- `request-ride` - Usuário solicita corrida
- `accept-ride` - Motorista aceita corrida
- `start-ride` - Iniciar corrida
- `end-ride` - Finalizar corrida

## 🗄️ Estrutura do Firebase

```
users/
  ├── {uid}/
  │   ├── email
  │   ├── name
  │   ├── userType (passenger/driver)
  │   ├── rating
  │   ├── isOnline
  │   └── currentLocation

rides/
  ├── {rideId}/
  │   ├── userId
  │   ├── driverId
  │   ├── status
  │   ├── pickup
  │   ├── destination
  │   └── price

locations/
  ├── {userId}/
  │   ├── lat
  │   ├── lng
  │   └── timestamp

ratings/
  ├── {driverId}/
  │   └── {ratingId}/
  │       ├── rating
  │       └── comment
```

## 🔐 Segurança

- ✅ Autenticação com JWT
- ✅ Senhas criptografadas com bcrypt
- ✅ CORS configurado
- ✅ Validação de entrada
- ✅ Firebase Security Rules (configure no console)

## 🚀 Deploy

### Heroku
```bash
git push heroku main
```

### Google Cloud Run
```bash
gcloud run deploy uber-clone-backend --source .
```

### AWS EC2
```bash
# Copie os arquivos e execute:
npm install && npm start
```

## 📝 Próximas Melhorias

- [ ] Sistema de pagamento (Stripe/PagSeguro)
- [ ] Chat em tempo real (socket.io melhorado)
- [ ] Notificações push
- [ ] Cálculo automático de preço
- [ ] Análise de dados e analytics
- [ ] Admin dashboard

## 🐛 Troubleshooting

**Erro: "FIREBASE_PROJECT_ID not found"**
- Verifique o arquivo .env e as credenciais do Firebase

**Porta já em uso?**
```bash
lsof -i :5000
kill -9 <PID>
```

## 📞 Suporte

Abra uma issue no repositório ou entre em contato!

---

**Feito com ❤️ por Eric-Jose**
