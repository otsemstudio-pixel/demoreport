// server.js
// Serveur backend du site Ncréa.
// Reçoit les soumissions du formulaire "Démarrer un projet" et du formulaire de contact,
// puis envoie automatiquement UN EMAIL et UN SMS à l'agence.
//
// Installation :  npm install
// Configuration : copier .env.example en .env et renseigner les vraies valeurs
// Démarrage :     npm start

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');

const PORT = process.env.PORT || 3000;

// Domaine(s) autorisé(s) à appeler cette API (le(s) domaine(s) où le site est hébergé).
// En développement, ALLOWED_ORIGIN peut valoir "*". En production, mettez votre vrai domaine.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL || 'otsemstudio@gmail.com';
// Numéro qui recevra le SMS, au format international sans "+" pour Africa's Talking (ex: 250799496971)
const RECIPIENT_PHONE = process.env.RECIPIENT_PHONE || '250799496971';

// ---------- Email (Gmail via Nodemailer) ----------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD, // "mot de passe d'application" Google, pas le mot de passe normal
  },
});

async function sendEmail({ subject, text, replyTo }) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD manquants dans .env');
  }
  return transporter.sendMail({
    from: `"Site Ncréa" <${process.env.GMAIL_USER}>`,
    to: RECIPIENT_EMAIL,
    replyTo: replyTo || undefined, // permet de cliquer "Répondre" et écrire directement au client
    subject,
    text,
  });
}

// ---------- SMS (Africa's Talking) ----------
let smsClient = null;
if (process.env.AT_API_KEY && process.env.AT_USERNAME) {
  const AfricasTalking = require('africastalking')({
    apiKey: process.env.AT_API_KEY,
    username: process.env.AT_USERNAME,
  });
  smsClient = AfricasTalking.SMS;
}

async function sendSms(message) {
  if (!smsClient) {
    throw new Error('AT_API_KEY / AT_USERNAME manquants dans .env');
  }
  return smsClient.send({
    to: [RECIPIENT_PHONE.startsWith('+') ? RECIPIENT_PHONE : '+' + RECIPIENT_PHONE],
    message,
  });
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(
  cors({
    origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(',').map((s) => s.trim()),
  })
);

// Limite le nombre de soumissions par IP (protège contre le spam et les coûts SMS)
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Trop de requêtes, réessayez plus tard.' },
});

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
function isValidEmail(v) {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------- Formulaire "Démarrer un projet" ----------
app.post('/api/project-request', submitLimiter, async (req, res) => {
  const { company, name, email, phone, axes, description, budget, delai, dispo } = req.body || {};

  if (!isNonEmptyString(company) || !isNonEmptyString(name) || !isValidEmail(email) || !isNonEmptyString(description)) {
    return res.status(400).json({ ok: false, error: 'Champs requis manquants ou invalides.' });
  }

  const axesText = Array.isArray(axes) && axes.length ? axes.join(', ') : 'Non précisé';

  const emailSubject = `Nouvelle demande de projet — ${company}`;
  const emailBody =
    `Entreprise : ${company}\n` +
    `Contact : ${name}\n` +
    `Email : ${email}\n` +
    `Téléphone : ${phone || 'Non renseigné'}\n` +
    `Axe(s) concerné(s) : ${axesText}\n` +
    `Budget approximatif : ${budget || 'Non précisé'}\n` +
    `Délai souhaité : ${delai || 'Non précisé'}\n` +
    `Disponibilités : ${dispo || 'Non renseigné'}\n\n` +
    `Description du projet :\n${description}\n\n` +
    `— Répondez directement à cet email pour écrire à ${name}.`;

  const smsBody =
    `Ncréa — nouvelle demande : ${company} (${name}). ` +
    `Axe(s): ${axesText}. Budget: ${budget || 'N/A'}. Email: ${email}. Voir votre boîte mail pour le détail.`;

  const result = { ok: true, email: 'skipped', sms: 'skipped' };

  try {
    await sendEmail({ subject: emailSubject, text: emailBody, replyTo: email });
    result.email = 'sent';
  } catch (err) {
    console.error('Erreur envoi email:', err.message);
    result.email = 'failed';
    result.ok = false;
  }

  try {
    await sendSms(smsBody);
    result.sms = 'sent';
  } catch (err) {
    console.error('Erreur envoi SMS:', err.message);
    result.sms = 'failed';
    // On ne bloque pas la requête si seul le SMS échoue et que l'email est parti.
  }

  res.status(result.email === 'sent' ? 200 : 502).json(result);
});

// ---------- Formulaire de contact simple ----------
app.post('/api/contact-message', submitLimiter, async (req, res) => {
  const { name, email, subject, message } = req.body || {};

  if (!isNonEmptyString(name) || !isValidEmail(email) || !isNonEmptyString(message)) {
    return res.status(400).json({ ok: false, error: 'Champs requis manquants ou invalides.' });
  }

  const emailSubject = subject && isNonEmptyString(subject) ? subject : `Message depuis le site Ncréa — ${name}`;
  const emailBody = `Nom : ${name}\nEmail : ${email}\n\n${message}\n\n— Répondez directement à cet email pour écrire à ${name}.`;
  const smsBody = `Ncréa — nouveau message de ${name} (${email}). Voir votre boîte mail pour le détail.`;

  const result = { ok: true, email: 'skipped', sms: 'skipped' };

  try {
    await sendEmail({ subject: emailSubject, text: emailBody, replyTo: email });
    result.email = 'sent';
  } catch (err) {
    console.error('Erreur envoi email:', err.message);
    result.email = 'failed';
    result.ok = false;
  }

  try {
    await sendSms(smsBody);
    result.sms = 'sent';
  } catch (err) {
    console.error('Erreur envoi SMS:', err.message);
    result.sms = 'failed';
  }

  res.status(result.email === 'sent' ? 200 : 502).json(result);
});

app.listen(PORT, () => {
  console.log(`Serveur Ncréa démarré sur le port ${PORT}`);
});
