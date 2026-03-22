const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');

const app = express();
const root = __dirname;
const port = Number(process.env.PORT) || 3000;

const ALLOWED_EMAILS = new Set([
  'mariovalney@gmail.com',
  'lu.nagasaka@gmail.com',
  'ig.pessoa@gmail.com',
]);

app.disable('x-powered-by');
app.set('trust proxy', 1); // necessário atrás do reverse proxy do Easypanel

const AUTH_ENABLED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (!AUTH_ENABLED) {
  console.warn('⚠ GOOGLE_CLIENT_ID/SECRET não definidos — autenticação desativada (modo dev)');
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'bue-2026-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
  },
}));

if (AUTH_ENABLED) {
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: '/auth/google/callback',
    },
    (_accessToken, _refreshToken, profile, done) => {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (ALLOWED_EMAILS.has(email)) {
        return done(null, {
          email,
          name: profile.displayName,
          photo: profile.photos?.[0]?.value,
        });
      }
      return done(null, false);
    }
  ));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));
  app.use(passport.initialize());
  app.use(passport.session());
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED || req.isAuthenticated()) return next();
  res.redirect('/login');
}

// ── Auth routes ──────────────────────────────────────────────
app.get('/auth/google', passport.authenticate('google', { scope: ['email', 'profile'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?erro=1' }),
  (_req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/login'));
});

// ── Pages ────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.sendFile(path.join(root, 'login.html'));
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json(req.user);
});

// ── Cache headers ────────────────────────────────────────────
const NO_CACHE = 'no-cache, no-store, must-revalidate';

app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(root, 'sw.js'));
});

app.get('/', requireAuth, (req, res) => {
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(root, 'index.html'));
});

app.use(express.static(root, {
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.png') || filePath.endsWith('manifest.json')) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  },
}));

app.listen(port, '0.0.0.0', () => {
  console.log(`http://0.0.0.0:${port}`);
});
