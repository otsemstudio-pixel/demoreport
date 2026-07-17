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
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// Domaine(s) autorisé(s) à appeler cette API (le(s) domaine(s) où le site est hébergé).
// En développement, ALLOWED_ORIGIN peut valoir "*". En production, mettez votre vrai domaine.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL || 'otsemstudio@gmail.com';
// Numéro qui recevra le SMS, au format international sans "+" pour Africa's Talking (ex: 250799496971)
const RECIPIENT_PHONE = process.env.RECIPIENT_PHONE || '250799496971';

// ---------- Supabase (base de données + stockage des images du portfolio) ----------
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}
const PROJECT_BUCKET = 'project-images';

// ---------- Authentification admin (panneau /admin.html) ----------
// Simple et proportionné à l'usage : un seul mot de passe, un seul token de session.
// Le mot de passe n'est jamais stocké côté client ; seul le token (généré aléatoirement
// à chaque démarrage du serveur, ou fixé via ADMIN_TOKEN) est gardé dans le navigateur
// après une connexion réussie.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ ok: false, error: 'ADMIN_PASSWORD non configuré côté serveur.' });
  }
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Non autorisé.' });
  }
  next();
}

// ---------- Email (Brevo — API HTTPS, fonctionne même sur les plans gratuits) ----------
// Les hébergeurs gratuits (Render, Vercel, etc.) bloquent désormais le SMTP classique
// (ports 25/465/587). Brevo envoie via une requête HTTPS normale (port 443), donc ça
// fonctionne sans upgrade payant. Voir server/README.md pour la configuration.
async function sendEmail({ to, subject, text, replyTo }) {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
    throw new Error('BREVO_API_KEY / BREVO_SENDER_EMAIL manquants dans .env');
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: { name: 'Ncréa', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: to || RECIPIENT_EMAIL }],
      replyTo: replyTo ? { email: replyTo } : undefined,
      subject,
      textContent: text,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Brevo a refusé l'envoi (${res.status}): ${errText}`);
  }

  return res.json();
}

// ---------- Emails de confirmation envoyés au client (pas à l'agence) ----------
function projectConfirmationEmail(lang, { name, company }) {
  const isEn = lang === 'en';
  if (isEn) {
    return {
      subject: `Ncréa received your request — ${company}`,
      text:
        `Hi ${name},\n\n` +
        `Thank you for reaching out about ${company} — we've received your request.\n\n` +
        `Here's what happens next:\n` +
        `1. Reviewing your request — we get back to you within 48h.\n` +
        `2. Scoping call — a conversation to clarify the need and discuss pricing.\n` +
        `3. Quote & agreement — you validate the exact scope and price.\n` +
        `4. 50% deposit — paid once the quote is approved to start production, the balance due on final delivery.\n\n` +
        `In the meantime, feel free to write to us directly at otsemstudio@gmail.com or on WhatsApp at +250 799 496 971 if you have any question.\n\n` +
        `Talk soon,\nThe Ncréa team`,
    };
  }
  return {
    subject: `Ncréa a bien reçu votre demande — ${company}`,
    text:
      `Bonjour ${name},\n\n` +
      `Merci pour votre demande concernant ${company} — nous l'avons bien reçue.\n\n` +
      `Voici comment se déroule la suite :\n` +
      `1. Étude de votre demande — nous revenons vers vous sous 48h.\n` +
      `2. Rendez-vous de cadrage — un échange pour préciser le besoin et discuter du prix.\n` +
      `3. Devis & accord — vous validez le périmètre exact et le tarif convenu.\n` +
      `4. Acompte de 50 % — réglé à la validation du devis pour lancer la production, le solde étant dû à la livraison finale.\n\n` +
      `En attendant, n'hésitez pas à nous écrire directement à otsemstudio@gmail.com ou par WhatsApp au +250 799 496 971 si vous avez une question.\n\n` +
      `À très vite,\nL'équipe Ncréa`,
  };
}

function contactConfirmationEmail(lang, { name, message }) {
  const isEn = lang === 'en';
  if (isEn) {
    return {
      subject: `We received your message — Ncréa`,
      text:
        `Hi ${name},\n\n` +
        `Thank you for your message! We'll get back to you as soon as possible, usually within 48h.\n\n` +
        `For reference, here's what you sent us:\n"${message}"\n\n` +
        `Talk soon,\nThe Ncréa team`,
    };
  }
  return {
    subject: `Nous avons bien reçu votre message — Ncréa`,
    text:
      `Bonjour ${name},\n\n` +
      `Merci pour votre message ! Nous vous répondrons dans les meilleurs délais, généralement sous 48h.\n\n` +
      `Pour rappel, voici ce que vous nous avez écrit :\n« ${message} »\n\n` +
      `À très vite,\nL'équipe Ncréa`,
  };
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

// Render (et la plupart des hébergeurs) placent l'app derrière un proxy inverse.
// Sans ce réglage, express-rate-limit lève une erreur de validation sur l'en-tête X-Forwarded-For.
app.set('trust proxy', 1);

app.use(express.json({ limit: '15mb' }));
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

// ============================================================
// Portfolio de projets (public en lecture, admin en écriture)
// ============================================================

function requireSupabase(res) {
  if (!supabase) {
    res.status(503).json({ ok: false, error: 'Supabase non configuré côté serveur (SUPABASE_URL / SUPABASE_SERVICE_KEY manquants).' });
    return false;
  }
  return true;
}

// --- Lecture publique : utilisée par realisations.html ---
app.get('/api/projects', async (req, res) => {
  if (!requireSupabase(res)) return;
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, projects: data });
});

// --- Connexion admin : renvoie le token de session si le mot de passe est correct ---
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ ok: false, error: 'ADMIN_PASSWORD non configuré côté serveur.' });
  }
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Mot de passe incorrect.' });
  }
  res.json({ ok: true, token: ADMIN_TOKEN });
});

// --- Upload d'une image vers Supabase Storage (admin uniquement) ---
// Attend { fileName, contentType, dataBase64 } — l'image est envoyée encodée en base64.
app.post('/api/admin/upload', requireAdmin, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { fileName, contentType, dataBase64 } = req.body || {};
  if (!isNonEmptyString(fileName) || !isNonEmptyString(contentType) || !isNonEmptyString(dataBase64)) {
    return res.status(400).json({ ok: false, error: 'fileName, contentType et dataBase64 sont requis.' });
  }

  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${Date.now()}-${Math.round(Math.random() * 1e6)}-${safeName}`;
  const buffer = Buffer.from(dataBase64, 'base64');

  const { error: uploadError } = await supabase.storage
    .from(PROJECT_BUCKET)
    .upload(path, buffer, { contentType, upsert: false });

  if (uploadError) return res.status(500).json({ ok: false, error: uploadError.message });

  const { data } = supabase.storage.from(PROJECT_BUCKET).getPublicUrl(path);
  res.json({ ok: true, url: data.publicUrl });
});

// --- Créer un projet (admin uniquement) ---
app.post('/api/admin/projects', requireAdmin, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { title, axis, why, logo_url, declinations, sketches, process_images, logo_supports, videos, sort_order } = req.body || {};

  if (!isNonEmptyString(title) || !['visuel', 'uxui', 'anim2d'].includes(axis)) {
    return res.status(400).json({ ok: false, error: 'title et axis (visuel|uxui|anim2d) sont requis.' });
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({
      title,
      axis,
      why: why || '',
      logo_url: logo_url || null,
      declinations: declinations || [],
      sketches: sketches || [],
      process_images: process_images || [],
      logo_supports: logo_supports || [],
      videos: videos || [],
      sort_order: Number.isFinite(sort_order) ? sort_order : 0,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, project: data });
});

// --- Modifier un projet (admin uniquement) ---
app.put('/api/admin/projects/:id', requireAdmin, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { id } = req.params;
  const { title, axis, why, logo_url, declinations, sketches, process_images, logo_supports, videos, sort_order } = req.body || {};

  const update = {};
  if (title !== undefined) update.title = title;
  if (axis !== undefined) update.axis = axis;
  if (why !== undefined) update.why = why;
  if (logo_url !== undefined) update.logo_url = logo_url;
  if (declinations !== undefined) update.declinations = declinations;
  if (sketches !== undefined) update.sketches = sketches;
  if (process_images !== undefined) update.process_images = process_images;
  if (logo_supports !== undefined) update.logo_supports = logo_supports;
  if (videos !== undefined) update.videos = videos;
  if (sort_order !== undefined) update.sort_order = sort_order;

  const { data, error } = await supabase.from('projects').update(update).eq('id', id).select().single();
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, project: data });
});

// --- Supprimer un projet (admin uniquement) ---
app.delete('/api/admin/projects/:id', requireAdmin, async (req, res) => {
  if (!requireSupabase(res)) return;
  const { id } = req.params;
  const { error } = await supabase.from('projects').delete().eq('id', id);
  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

// ---------- Formulaire "Démarrer un projet" ----------
app.post('/api/project-request', submitLimiter, async (req, res) => {
  const { company, name, email, phone, axes, description, budget, delai, dispo, lang } = req.body || {};

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

  const result = { ok: true, email: 'skipped', sms: 'skipped', clientEmail: 'skipped' };

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

  try {
    const confirmation = projectConfirmationEmail(lang, { name, company });
    await sendEmail({ to: email, subject: confirmation.subject, text: confirmation.text, replyTo: RECIPIENT_EMAIL });
    result.clientEmail = 'sent';
  } catch (err) {
    console.error('Erreur envoi email de confirmation client:', err.message);
    result.clientEmail = 'failed';
    // Non bloquant : la demande principale a déjà été traitée ci-dessus.
  }

  res.status(result.email === 'sent' ? 200 : 502).json(result);
});

// ---------- Formulaire de contact simple ----------
app.post('/api/contact-message', submitLimiter, async (req, res) => {
  const { name, email, subject, message, lang } = req.body || {};

  if (!isNonEmptyString(name) || !isValidEmail(email) || !isNonEmptyString(message)) {
    return res.status(400).json({ ok: false, error: 'Champs requis manquants ou invalides.' });
  }

  const emailSubject = subject && isNonEmptyString(subject) ? subject : `Message depuis le site Ncréa — ${name}`;
  const emailBody = `Nom : ${name}\nEmail : ${email}\n\n${message}\n\n— Répondez directement à cet email pour écrire à ${name}.`;
  const smsBody = `Ncréa — nouveau message de ${name} (${email}). Voir votre boîte mail pour le détail.`;

  const result = { ok: true, email: 'skipped', sms: 'skipped', clientEmail: 'skipped' };

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

  try {
    const confirmation = contactConfirmationEmail(lang, { name, message });
    await sendEmail({ to: email, subject: confirmation.subject, text: confirmation.text, replyTo: RECIPIENT_EMAIL });
    result.clientEmail = 'sent';
  } catch (err) {
    console.error('Erreur envoi email de confirmation client:', err.message);
    result.clientEmail = 'failed';
  }

  res.status(result.email === 'sent' ? 200 : 502).json(result);
});

app.listen(PORT, () => {
  console.log(`Serveur Ncréa démarré sur le port ${PORT}`);
});
