require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs      = require('fs');
const path    = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { Strategy: MicrosoftStrategy } = require('passport-microsoft');
const mongoose = require('mongoose');
const multer   = require('multer');
const webpush  = require('web-push');
const Event    = require('./models/Event');
const PushSub  = require('./models/PushSubscription');
const User     = require('./models/User');

const app        = express();
const root       = path.join(__dirname, '..', 'public');   // static files
const projectDir = path.join(__dirname, '..');             // project root
const port = Number(process.env.PORT) || 3000;

// ── Uploads dir ──────────────────────────────────────────────
const uploadsDir = path.join(projectDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

// ── Allowed users ────────────────────────────────────────────
const ALLOWED_EMAILS = new Set([
  'mariovalney@gmail.com',
  'lu.nagasaka@gmail.com',
  'ig.pessoa@gmail.com',
  'diandradb@hotmail.com',
]);

const FRIEND_EMAILS = [
  'mariovalney@gmail.com',
  'lu.nagasaka@gmail.com',
  'ig.pessoa@gmail.com',
  'diandradb@hotmail.com',
];

/** Simplified mainland Brazil bounding box: if inside, store GRU instead of raw coords. */
function isInBrazil(lat, lng) {
  return lat >= -33.75 && lat <= 5.27 && lng >= -73.99 && lng <= -28.84;
}

const GRU_LAT = -23.4302175;
const GRU_LNG = -46.47167109999999;

// ── Web Push ─────────────────────────────────────────────────
const PUSH_ENABLED = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(
    'mailto:mariovalney@gmail.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

async function notifySubscribers(title, body, eventId = null) {
  if (!PUSH_ENABLED) return;
  const subs = await PushSub.find();
  const payload = JSON.stringify({
    title,
    body,
    ...(eventId != null ? { eventId: String(eventId) } : {}),
  });
  subs.forEach(s => webpush.sendNotification(s.subscription, payload).catch(() => {}));
}

// ── Multer ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename:    (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

async function upsertOAuthUser(email, name, photo) {
  if (!email || !ALLOWED_EMAILS.has(email)) return false;
  await User.findOneAndUpdate(
    { email },
    {
      name:      name || '',
      photo:     photo ?? null,
      lastLogin: new Date(),
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
  return true;
}

function microsoftEmailFromProfile(profile) {
  const fromList = profile.emails?.map((e) => e?.value).find(Boolean);
  if (fromList) return String(fromList).toLowerCase();
  const upn = profile.userPrincipalName;
  if (upn && String(upn).includes('@')) return String(upn).toLowerCase();
  return null;
}

// ── Express core ─────────────────────────────────────────────
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json());

const GOOGLE_AUTH = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const MICROSOFT_AUTH = !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
const AUTH_ENABLED = GOOGLE_AUTH || MICROSOFT_AUTH;
if (!AUTH_ENABLED) {
  console.warn('⚠ Auth desativado (modo dev) — defina GOOGLE_* ou MICROSOFT_* OAuth');
}

app.get('/api/auth/providers', (_req, res) => {
  res.json({ google: GOOGLE_AUTH, microsoft: MICROSOFT_AUTH });
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'bue-2026-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

if (AUTH_ENABLED) {
  passport.serializeUser((email, done) => done(null, email));
  passport.deserializeUser(async (email, done) => {
    try {
      const doc = await User.findOne({ email });
      if (!doc) return done(null, false);
      return done(null, {
        email:          doc.email,
        name:           doc.name,
        photo:          doc.photo,
        shareLocation:  doc.shareLocation !== false,
        lastLat:        doc.lastLat,
        lastLng:        doc.lastLng,
        lastLocationAt: doc.lastLocationAt,
      });
    } catch (e) {
      return done(e);
    }
  });
  app.use(passport.initialize());
  app.use(passport.session());

  if (GOOGLE_AUTH) {
    passport.use(new GoogleStrategy(
      {
        clientID:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:  process.env.CALLBACK_URL || '/auth/google/callback',
      },
      async (_at, _rt, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value?.toLowerCase();
          const ok = await upsertOAuthUser(
            email,
            profile.displayName || '',
            profile.photos?.[0]?.value || null
          );
          if (!ok) return done(null, false);
          return done(null, email);
        } catch (err) {
          return done(err);
        }
      }
    ));
  }

  if (MICROSOFT_AUTH) {
    passport.use(new MicrosoftStrategy(
      {
        clientID:      process.env.MICROSOFT_CLIENT_ID,
        clientSecret:  process.env.MICROSOFT_CLIENT_SECRET,
        callbackURL:   process.env.MICROSOFT_CALLBACK_URL || '/auth/microsoft/callback',
        scope:         ['user.read'],
        addUPNAsEmail: true,
      },
      async (_at, _rt, profile, done) => {
        try {
          const email = microsoftEmailFromProfile(profile);
          const ok = await upsertOAuthUser(email, profile.displayName || '', null);
          if (!ok) return done(null, false);
          return done(null, email);
        } catch (err) {
          return done(err);
        }
      }
    ));
  }
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED || req.isAuthenticated()) return next();
  res.redirect('/login');
}

// ── Auth routes ──────────────────────────────────────────────
if (GOOGLE_AUTH) {
  app.get('/auth/google', passport.authenticate('google', { scope: ['email', 'profile'] }));

  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/login?erro=1' }),
    (_req, res) => res.redirect('/')
  );
}

if (MICROSOFT_AUTH) {
  app.get('/auth/microsoft', passport.authenticate('microsoft', { prompt: 'select_account' }));

  app.get('/auth/microsoft/callback',
    passport.authenticate('microsoft', { failureRedirect: '/login?erro=1' }),
    (_req, res) => res.redirect('/')
  );
}

app.get('/logout', (req, res) => {
  if (!AUTH_ENABLED) return res.redirect('/');
  req.logout(() => res.redirect('/login'));
});

// ── API ──────────────────────────────────────────────────────
function isValidIsoTime(s) {
  if (s === undefined || s === null) return false;
  const t = Date.parse(String(s).trim());
  return !Number.isNaN(t);
}

app.get('/api/me', requireAuth, async (req, res) => {
  if (!AUTH_ENABLED) {
    return res.json({
      name: 'Dev',
      email: 'dev@dev',
      photo: null,
      shareLocation: true,
      lastLat: null,
      lastLng: null,
      lastLocationAt: null,
    });
  }
  try {
    const doc = await User.findOne({ email: req.user.email }).lean();
    if (!doc) return res.json(req.user);
    res.json({
      name:           doc.name,
      email:          doc.email,
      photo:          doc.photo,
      shareLocation:  doc.shareLocation !== false,
      lastLat:        doc.lastLat,
      lastLng:        doc.lastLng,
      lastLocationAt: doc.lastLocationAt,
    });
  } catch (e) {
    res.status(500).json({ error: 'me failed' });
  }
});

app.patch('/api/me/preferences', requireAuth, async (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true });
  const { shareLocation } = req.body;
  if (typeof shareLocation !== 'boolean') {
    return res.status(400).json({ error: 'shareLocation boolean required' });
  }
  const doc = await User.findOneAndUpdate(
    { email: req.user.email },
    { shareLocation },
    { returnDocument: 'after' }
  );
  if (!doc) return res.status(404).json({ error: 'User not found' });
  res.json({
    shareLocation: doc.shareLocation !== false,
    lastLat: doc.lastLat,
    lastLng: doc.lastLng,
    lastLocationAt: doc.lastLocationAt,
  });
});

app.post('/api/me/location', requireAuth, async (req, res) => {
  if (!AUTH_ENABLED) return res.json({ ok: true });
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat and lng required' });
  }
  let storeLat = lat;
  let storeLng = lng;
  if (isInBrazil(lat, lng)) {
    storeLat = GRU_LAT;
    storeLng = GRU_LNG;
  }
  const doc = await User.findOneAndUpdate(
    { email: req.user.email },
    { lastLat: storeLat, lastLng: storeLng, lastLocationAt: new Date() },
    { returnDocument: 'after' }
  );
  if (!doc) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true, lat: doc.lastLat, lng: doc.lastLng, lastLocationAt: doc.lastLocationAt });
});

app.get('/api/friends/locations', requireAuth, async (req, res) => {
  if (!AUTH_ENABLED) {
    return res.json([]);
  }
  const users = await User.find({ email: { $in: FRIEND_EMAILS } }).lean();
  const byEmail = new Map(users.map(u => [u.email, u]));
  const out = FRIEND_EMAILS.map((email) => {
    const u = byEmail.get(email);
    return {
      email,
      name: u?.name || null,
      lat: u?.lastLat ?? null,
      lng: u?.lastLng ?? null,
      updatedAt: u?.lastLocationAt || null,
    };
  });
  res.json(out);
});

app.get('/api/config', (_req, res) => {
  res.json({
    mapsKey: process.env.GOOGLE_MAPS_API_KEY || null,
    pushPrompt: process.env.NODE_ENV === 'production',
    airbnbAddress: 'Córdoba 5443, Palermo, Buenos Aires',
    airbnbLat: -34.5881959,
    airbnbLng: -58.4387735,
  });
});

app.get('/api/fx/ars-brl', requireAuth, async (_req, res) => {
  const token = (process.env.AWESOME_API_KEY || '').trim();
  if (!token) {
    return res.status(503).json({ error: 'Câmbio indisponível (AWESOME_API_KEY não configurada)' });
  }
  const url = `https://economia.awesomeapi.com.br/json/last/ARS?token=${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) {
      return res.status(502).json({ error: 'Falha ao obter cotação' });
    }
    const data = await r.json();
    const row = data.ARSBRL;
    if (!row || row.bid == null) {
      return res.status(502).json({ error: 'Resposta de câmbio inválida' });
    }
    const rate = parseFloat(String(row.bid).replace(',', '.'));
    if (!Number.isFinite(rate)) {
      return res.status(502).json({ error: 'Resposta de câmbio inválida' });
    }
    res.json({
      rate,
      quotedAt: row.create_date || null,
    });
  } catch {
    res.status(502).json({ error: 'Falha ao obter cotação' });
  }
});

app.get('/api/events', requireAuth, async (_req, res) => {
  const events = await Event.find().sort({ day: 1, order: 1 });
  res.json(events);
});

app.post('/api/events', requireAuth, async (req, res) => {
  const notify = req.body.notify === true;
  const { notify: _n, ...body } = req.body;
  const day = Number(body.day);
  if (Number.isNaN(day) || day < 0 || day > 3) {
    return res.status(400).json({ error: 'Invalid day' });
  }
  const title = (body.title ?? '').trim();
  if (!title) return res.status(400).json({ error: 'Título obrigatório' });
  if (!isValidIsoTime(body.isoTime)) {
    return res.status(400).json({ error: 'isoTime obrigatório (data ISO válida)' });
  }
  const last = await Event.findOne({ day }).sort({ order: -1 });
  const order = last ? last.order + 1 : 0;
  const event = await Event.create({
    day,
    order,
    isoTime:         String(body.isoTime).trim(),
    title,
    description:     body.description ?? '',
    link:            body.link ?? '',
    location:        body.location || { address: '', lat: null, lng: null },
    durationMinutes: body.durationMinutes ?? null,
    tags:            body.tags ?? [],
    photos:          body.photos ?? [],
    files:           body.files ?? [],
  });

  if (notify) {
    const who = req.user?.name?.split(' ')[0] || 'Alguém';
    await notifySubscribers(
      'Roteiro atualizado ✈',
      `${who} adicionou "${event.title}"`,
      event._id
    );
  }

  res.status(201).json(event);
});

app.put('/api/events/:id', requireAuth, async (req, res) => {
  const notify = req.body.notify === true;
  const { notify: _n, ...update } = req.body;
  delete update.time;
  const existing = await Event.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (update.title !== undefined) {
    const t = String(update.title).trim();
    if (!t) return res.status(400).json({ error: 'Título obrigatório' });
    update.title = t;
  }
  const isoCandidate = update.isoTime !== undefined ? update.isoTime : existing.isoTime;
  if (!isValidIsoTime(isoCandidate)) {
    return res.status(400).json({ error: 'isoTime inválido ou em falta' });
  }
  update.isoTime = String(isoCandidate).trim();
  const event = await Event.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after', runValidators: true });
  if (!event) return res.status(404).json({ error: 'Not found' });

  if (notify) {
    const who = req.user?.name?.split(' ')[0] || 'Alguém';
    await notifySubscribers(
      'Roteiro atualizado ✈',
      `${who} editou "${event.title}"`,
      event._id
    );
  }

  res.json(event);
});

app.post('/api/events/:id/photos', requireAuth, upload.array('photos', 20), async (req, res) => {
  const filenames = (req.files || []).map(f => f.filename);
  const event = await Event.findByIdAndUpdate(
    req.params.id,
    { $push: { photos: { $each: filenames } } },
    { returnDocument: 'after' }
  );
  res.json(event);
});

app.delete('/api/events/:id/photos/:filename', requireAuth, async (req, res) => {
  const { id, filename } = req.params;
  const filePath = path.join(uploadsDir, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const event = await Event.findByIdAndUpdate(id, { $pull: { photos: filename } }, { returnDocument: 'after' });
  res.json(event);
});

app.post('/api/events/:id/files', requireAuth, upload.array('files', 20), async (req, res) => {
  const filenames = (req.files || []).map(f => f.filename);
  const event = await Event.findByIdAndUpdate(
    req.params.id,
    { $push: { files: { $each: filenames } } },
    { returnDocument: 'after' }
  );
  res.json(event);
});

app.delete('/api/events/:id/files/:filename', requireAuth, async (req, res) => {
  const { id, filename } = req.params;
  const filePath = path.join(uploadsDir, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const event = await Event.findByIdAndUpdate(id, { $pull: { files: filename } }, { returnDocument: 'after' });
  res.json(event);
});

app.delete('/api/events/:id', requireAuth, async (req, res) => {
  const ev = await Event.findById(req.params.id);
  if (!ev) return res.status(404).json({ error: 'Not found' });
  for (const f of [...(ev.photos || []), ...(ev.files || [])]) {
    const fp = path.join(uploadsDir, f);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  await Event.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

app.get('/api/push/vapid-key', (_req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const { subscription } = req.body;
  const email = req.user?.email || 'dev@dev';
  await PushSub.findOneAndUpdate({ email }, { email, subscription }, { upsert: true, returnDocument: 'after' });
  res.json({ ok: true });
});

// ── Pages ────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (AUTH_ENABLED && req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(root, 'login.html'));
});

const NO_CACHE = 'no-cache, no-store, must-revalidate';

app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(root, 'sw.js'));
});

function sendAppIndex(res) {
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(root, 'index.html'));
}

app.get('/', requireAuth, (req, res) => sendAppIndex(res));

['/27-mar', '/28-mar', '/29-mar', '/30-mar'].forEach((seg) => {
  app.get(seg, requireAuth, (_req, res) => sendAppIndex(res));
});
app.get('/info', requireAuth, (_req, res) => sendAppIndex(res));

app.get('/e/:id/editar', requireAuth, (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(404).send('Not found');
  sendAppIndex(res);
});
app.get('/e/:id', requireAuth, (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(404).send('Not found');
  sendAppIndex(res);
});

app.use('/uploads', express.static(uploadsDir));

app.use(express.static(root, {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.png') || filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  },
}));

// ── Seed data ────────────────────────────────────────────────
const SEED = [
  { day:0, order:0, isoTime:'2026-03-27T10:00:00-03:00', title:'Chegada & Check-in', description:'Deslocamento de ~40 minutos do aeroporto AEP até o Airbnb. Check-in e organização das malas.', tags:[{label:'Airbnb'},{label:'~40 min'}] },
  { day:0, order:1, isoTime:'2026-03-27T10:30:00-03:00', title:'Mercado NYI Express + Cuervo Café', description:'Atividade a confirmar.', tags:[{label:'TBC',style:'red'},{label:'Café'}] },
  { day:0, order:2, isoTime:'2026-03-27T14:00:00-03:00', title:'Galerias Pacífico', description:'Shopping histórico no centro com afrescos no teto e arquitetura belíssima. Compras e passeio cultural.', tags:[{label:'Compras'},{label:'Centro'}] },
  { day:0, order:3, isoTime:'2026-03-27T20:00:00-03:00', title:'Trade Sky Rooftop', description:'Jantar com vista panorâmica do centro de Buenos Aires.', tags:[{label:'Restaurante',style:'dark'}] },
  { day:0, order:4, isoTime:'2026-03-27T19:00:00-03:00', title:'Tango — Café Tortoni', description:'Show de tango no café mais tradicional de Buenos Aires, fundado em 1858. Reserva obrigatória com antecedência.', tags:[{label:'Show',style:'dark'},{label:'Reservar',style:'red'}] },

  { day:1, order:0, isoTime:'2026-03-28T09:00:00-03:00', title:'Manhã Livre', description:'Descanso, explorar o bairro, cafezinho no ritmo porteño.', tags:[{label:'Livre'}] },
  { day:1, order:1, isoTime:'2026-03-28T12:00:00-03:00', title:'Confeitaria La Ideal', description:'Clássico porteño com ambiente belle époque. Café tardio ou almoço leve antes de seguir para a Recoleta.', tags:[{label:'Café & Almoço'}] },
  { day:1, order:2, isoTime:'2026-03-28T14:00:00-03:00', title:'Cemitério da Recoleta', description:'Necrópole suntuosa com mausoléus históricos, incluindo o túmulo de Eva Perón. Tour de ~2 horas pelo labirinto de mármores.', tags:[{label:'~2h'},{label:'Tour'},{label:'Reservado'}] },
  { day:1, order:3, isoTime:'2026-03-28T16:00:00-03:00', title:'El Ateneo Grand Splendid', description:'Considerada uma das livrarias mais belas do mundo, instalada em um antigo teatro de 1919 com palco e camarotes repletos de livros.', tags:[{label:'Imperdível',style:'dark'},{label:'Livros'}] },
  { day:1, order:4, isoTime:'2026-03-28T20:00:00-03:00', title:'Jantar — Lugar Secreto', description:'Destino reservado. A revelar no dia.', tags:[{label:'Surprise',style:'dark'}] },

  { day:2, order:0, isoTime:'2026-03-29T09:00:00-03:00', title:'Teatro Colón', description:'Uma das maiores óperas do mundo. A visita guiada percorre o palco, os bastidores e as galerias históricas.', tags:[{label:'~1h30'},{label:'Tour guiado'}] },
  { day:2, order:1, isoTime:'2026-03-29T12:00:00-03:00', title:'Almoço Livre', description:'Escolha espontânea. San Telmo tem opções para todos os gostos.', tags:[{label:'Livre'}] },
  { day:2, order:2, isoTime:'2026-03-29T14:00:00-03:00', title:'Mercado San Telmo', description:'Mercado coberto de 1897 com antiguidades, gastronomia e artesanato. O astral boho único de San Telmo.', tags:[{label:'Mercado'},{label:'San Telmo'}] },
  { day:2, order:3, isoTime:'2026-03-29T21:00:00-03:00', title:'Show — Ingrid & Diandra', description:'Show confirmado para a noite. Local e horário a verificar.', tags:[{label:'Show',style:'dark'}] },
  { day:2, order:4, isoTime:'2026-03-29T20:00:00-03:00', title:'Livre — Mário e Luana', description:'', tags:[{label:'Livre'}] },

  { day:3, order:0, isoTime:'2026-03-30T09:00:00-03:00', title:'Últimas Horas em BUE', description:'Arrumar as malas, último café porteño e guardar as memórias.' },
  { day:3, order:1, isoTime:'2026-03-30T10:00:00-03:00', title:'Saída para o Aeroporto', description:'~40 minutos de deslocamento até o AEP. Check-in e embarque com calma.', tags:[{label:'AEP'},{label:'~40 min'}] },
  { day:3, order:2, isoTime:'2026-03-30T12:55:00-03:00', title:'Voo de Retorno', description:'Buenos Aires → São Paulo. Chegada prevista às 15h35 no Aeroporto de Guarulhos.', tags:[{label:'~2h40',style:'dark'}] },
];

async function seedIfEmpty() {
  const count = await Event.countDocuments();
  if (count === 0) {
    await Event.insertMany(SEED);
    console.log(`Seeded ${SEED.length} events`);
  }
}

// ── DB connect + start ───────────────────────────────────────
async function connectDB() {
  if (process.env.MONGODB_URI) {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected');
  } else {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    console.log('MongoDB in-memory started');
  }
  await seedIfEmpty();
}

connectDB()
  .then(() => app.listen(port, '0.0.0.0', () => console.log(`http://0.0.0.0:${port}`)))
  .catch(err => { console.error('DB error:', err); process.exit(1); });
