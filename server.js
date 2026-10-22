const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, scryptSync, timingSafeEqual, createHash } = require('node:crypto');

const ROOT = __dirname;
const ENV_PATH = path.join(ROOT, '.env');
if (fs.existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const db = require('./lib/supabase');

const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_USER_ID = 'mocab';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SESSION_COOKIE = 'bp_session';
const USER_COOKIE = 'bp_user';
const SESSION_DAYS = 7;

function isoNow() {
  return new Date().toISOString();
}

function isoInDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readCookies(request) {
  const header = request.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return [part.trim(), ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

/* ---------- Consultas a Supabase ---------- */

async function findUserById(id) {
  const rows = await db.selectRows('users', {
    select: 'id,auth_user_id,username,display_name,email',
    filters: { id: `eq.${id}` },
    limit: 1,
  });
  return rows[0] || null;
}

async function findUserByUsername(username) {
  const rows = await db.selectRows('users', {
    select: 'id,auth_user_id,username,display_name,email',
    filters: { username: `eq.${username}` },
    limit: 1,
  });
  return rows[0] || null;
}

async function findUserByAuthId(authId) {
  const rows = await db.selectRows('users', {
    select: 'id,auth_user_id,username,display_name,email',
    filters: { auth_user_id: `eq.${authId}` },
    limit: 1,
  });
  return rows[0] || null;
}

async function findBusiness(brand) {
  const rows = await db.selectRows('businesses', {
    select: 'brand,contact,verified,password_salt,password_hash',
    filters: { brand: `eq.${brand}` },
    limit: 1,
  });
  return rows[0] || null;
}

function mapUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email || '',
    guest: false,
  };
}

function sanitizeUsername(value) {
  const base = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_.-]+/g, '')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 30);
  return base.length >= 3 ? base : `usuario-${randomBytes(2).toString('hex')}`;
}

async function uniqueUsername(base) {
  const root = sanitizeUsername(base);
  let candidate = root;
  let suffix = 2;
  while (await findUserByUsername(candidate)) {
    candidate = `${root.slice(0, 26)}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Crea el perfil local de un usuario de Supabase Auth. Se usa cuando la cuenta
 * se creó desde el panel de Supabase y todavía no tiene fila en `public.users`.
 */
async function createProfileForAuthUser(authUser) {
  const metadata = authUser.user_metadata || {};
  const email = String(authUser.email || '').toLowerCase();
  const username = await uniqueUsername(metadata.username || email.split('@')[0] || authUser.id);
  const displayName = String(
    metadata.display_name || metadata.displayName || metadata.full_name || username,
  ).trim().slice(0, 60) || username;
  const profile = {
    id: authUser.id,
    auth_user_id: authUser.id,
    username,
    display_name: displayName,
    email,
  };
  await db.insertRows('users', [profile], { returning: false });
  return profile;
}

async function currentBusiness(request) {
  const token = readCookies(request)[SESSION_COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const sessions = await db.selectRows('business_sessions', {
    select: 'brand',
    filters: { token: `eq.${token}`, expires_at: `gt.${isoNow()}` },
    limit: 1,
  });
  if (!sessions[0]) return null;
  const business = await findBusiness(sessions[0].brand);
  if (!business) return null;
  return { brand: business.brand, contact: business.contact, verified: Boolean(business.verified) };
}

async function requireBusiness(response, request) {
  const business = await currentBusiness(request);
  if (!business) {
    sendJson(response, 401, { error: 'Inicia sesión para administrar tus beneficios.' });
    return null;
  }
  return business;
}

/**
 * Usuario de la petición. Sin sesión devuelve el perfil local `mocab`, que
 * existe para que la app funcione antes de registrarse. En cuanto hay una
 * cuenta iniciada, sus canjes se guardan en esa cuenta y no en el visitante.
 */
async function currentUser(request) {
  const token = readCookies(request)[USER_COOKIE];
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const sessions = await db.selectRows('user_sessions', {
      select: 'user_id',
      filters: { token: `eq.${token}`, expires_at: `gt.${isoNow()}` },
      limit: 1,
    });
    if (sessions[0]) {
      const user = await findUserById(sessions[0].user_id);
      if (user) return mapUser(user);
    }
  }
  const guest = await findUserById(DEFAULT_USER_ID);
  return {
    id: guest ? guest.id : DEFAULT_USER_ID,
    username: guest ? guest.username : DEFAULT_USER_ID,
    displayName: guest ? guest.display_name : 'Mocab',
    email: guest ? (guest.email || '') : '',
    guest: true,
  };
}

async function startUserSession(request, response, userId, statusCode) {
  const token = randomBytes(32).toString('hex');
  await db.insertRows('user_sessions', [{
    token,
    user_id: userId,
    expires_at: isoInDays(SESSION_DAYS),
  }], { returning: false });
  void purgeExpiredSessions();

  const secure = isSecureRequest(request) ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${USER_COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`);

  // Los canjes que se hicieron como visitante se pasan a la cuenta nueva, para
  // que nadie pierda un código al registrarse. Solo si la cuenta está vacía.
  const own = await db.countRows('redemptions', { user_id: `eq.${userId}` });
  if (own === 0 && userId !== DEFAULT_USER_ID) {
    await db.updateRows('redemptions', { user_id: `eq.${DEFAULT_USER_ID}` }, { user_id: userId }, { returning: false });
  }

  const user = await findUserById(userId);
  return sendJson(response, statusCode, mapUser(user));
}

/* ---------- Sesiones, fechas y utilidades ---------- */

async function purgeExpiredSessions() {
  const now = isoNow();
  await Promise.allSettled([
    db.deleteRows('user_sessions', { expires_at: `lte.${now}` }),
    db.deleteRows('business_sessions', { expires_at: `lte.${now}` }),
  ]);
}

function isValidDate(value) {
  return value === null || value === '' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`)));
}

function isSecureRequest(request) {
  if (process.env.SECURE_COOKIES === '1') return true;
  if (process.env.SECURE_COOKIES === '0') return false;
  const forwarded = request.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https') return true;
  return Boolean(request.socket && request.socket.encrypted);
}

async function startSession(request, response, brand, statusCode) {
  const token = randomBytes(32).toString('hex');
  await db.insertRows('business_sessions', [{
    token,
    brand,
    expires_at: isoInDays(SESSION_DAYS),
  }], { returning: false });
  void purgeExpiredSessions();

  const secure = isSecureRequest(request) ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`);
  const business = await findBusiness(brand);
  return sendJson(response, statusCode, {
    brand: business.brand,
    contact: business.contact,
    verified: Boolean(business.verified),
  });
}

function brandInitials(brand) {
  return brand.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ ]/g, '').trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase() || 'BP';
}

function brandColor(brand) {
  const palette = ['#e9d7b4', '#e8b5a5', '#cbd9cf', '#d9c8b4', '#e8c978', '#bcd2b3', '#bed0d4', '#ddc8d8'];
  const total = [...brand].reduce((accumulator, character) => accumulator + character.charCodeAt(0), 0);
  return palette[Math.abs(total) % palette.length];
}

async function uniqueOfferId(brand) {
  const base = brand.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'negocio';
  let id = base;
  let suffix = 2;
  for (;;) {
    const rows = await db.selectRows('offers', { select: 'id', filters: { id: `eq.${id}` }, limit: 1 });
    if (!rows[0]) return id;
    id = `${base}-${suffix}`;
    suffix += 1;
  }
}

function readOfferFields(body, fallback = {}) {
  const text = (value, previous) => {
    if (typeof value !== 'string') return previous ?? '';
    return value.trim();
  };
  return {
    brand: text(body.brand, fallback.brand),
    category: text(body.category, fallback.category) || 'Otros',
    title: text(body.title, fallback.title),
    discountLabel: text(body.discountLabel ?? body.discount_label, fallback.discount_label ?? fallback.discountLabel),
    description: text(body.description, fallback.description),
    terms: text(body.terms, fallback.terms),
    location: text(body.location, fallback.location),
    imageUrl: text(body.imageUrl ?? body.image_url, fallback.image_url ?? fallback.imageUrl),
    expiresAt: text(body.expiresAt ?? body.expires_at, fallback.expires_at ?? fallback.expiresAt),
  };
}

function validateOfferFields(fields) {
  if (!fields.title || !fields.discountLabel || !fields.description || !fields.terms || !fields.location || !fields.imageUrl) {
    return 'Completa todos los campos obligatorios.';
  }
  if (fields.title.length > 120) return 'El título debe tener 120 caracteres o menos.';
  if (fields.description.length > 400) return 'La descripción debe tener 400 caracteres o menos.';
  if (fields.terms.length > 600) return 'Las condiciones deben tener 600 caracteres o menos.';
  if (fields.category.length > 40) return 'La categoría debe tener 40 caracteres o menos.';
  if (!/^https?:\/\/\S+$/i.test(fields.imageUrl)) return 'La imagen debe ser una dirección http o https válida.';
  if (!fields.expiresAt || !isValidDate(fields.expiresAt)) return 'Indica una fecha de vencimiento válida.';
  return null;
}

function toPublicOffer(row) {
  return { ...row, featured: Boolean(row.featured), active: Boolean(row.active) };
}

function normalizeText(value) {
  return String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/* ---------- Límite de intentos de acceso ---------- */

const attempts = new Map();
const ATTEMPT_LIMIT = 8;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

function throttleKey(request) {
  return request.socket.remoteAddress || 'desconocido';
}

function isThrottled(request) {
  const record = attempts.get(throttleKey(request));
  if (!record) return false;
  if (Date.now() - record.first > ATTEMPT_WINDOW_MS) {
    attempts.delete(throttleKey(request));
    return false;
  }
  return record.count >= ATTEMPT_LIMIT;
}

function registerFailure(request) {
  const key = throttleKey(request);
  const record = attempts.get(key);
  if (!record || Date.now() - record.first > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, first: Date.now() });
    return;
  }
  record.count += 1;
}

function clearFailures(request) {
  attempts.delete(throttleKey(request));
}

setInterval(() => {
  for (const [key, record] of attempts) {
    if (Date.now() - record.first > ATTEMPT_WINDOW_MS) attempts.delete(key);
  }
}, ATTEMPT_WINDOW_MS).unref();

/* ---------- API ---------- */

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) {
      throw Object.assign(new Error('El cuerpo de la solicitud es demasiado grande.'), { status: 413 });
    }
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw Object.assign(new Error('El JSON enviado no es válido.'), { status: 400 });
  }
}

async function handleApi(request, response, url) {
  const pathname = url.pathname;

  if (pathname === '/api/offers/categories' && request.method === 'GET') {
    const rows = await db.selectRows('offers', { select: 'category', filters: { active: 'eq.true' } });
    const counts = new Map();
    for (const row of rows) counts.set(row.category, (counts.get(row.category) || 0) + 1);
    const categories = [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => a.category.localeCompare(b.category, 'es'));
    return sendJson(response, 200, categories);
  }

  if (pathname === '/api/offers' && request.method === 'GET') {
    const category = url.searchParams.get('category');
    const search = url.searchParams.get('search')?.trim();
    const rows = await db.selectRows('offers', {
      select: '*',
      filters: { active: 'eq.true' },
      order: 'featured.desc,category.asc,brand.asc',
    });
    let offers = rows.map(toPublicOffer);
    if (category) offers = offers.filter((offer) => offer.category === category);
    if (search) {
      const needle = normalizeText(search);
      offers = offers.filter((offer) => normalizeText(
        `${offer.brand} ${offer.title} ${offer.description} ${offer.category}`,
      ).includes(needle));
    }
    return sendJson(response, 200, offers);
  }

  if (pathname === '/api/redemptions' && request.method === 'POST') {
    const user = await currentUser(request);
    const body = await readJson(request);
    const offerId = typeof body.offerId === 'string' ? body.offerId : '';
    const offers = await db.selectRows('offers', {
      select: 'id',
      filters: { id: `eq.${offerId}`, active: 'eq.true' },
      limit: 1,
    });
    if (!offers[0]) return sendJson(response, 404, { error: 'Este beneficio ya no está disponible.' });
    const code = `BP-${randomBytes(3).toString('hex').toUpperCase()}`;
    const inserted = await db.insertRows('redemptions', [{ offer_id: offerId, user_id: user.id, code }]);
    const row = inserted[0];
    return sendJson(response, 201, {
      id: row.id,
      offerId,
      userId: user.id,
      code,
      createdAt: row.created_at,
    });
  }

  if (pathname === '/api/users/register' && request.method === 'POST') {
    if (isThrottled(request)) return sendJson(response, 429, { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
    const body = await readJson(request);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) {
      return sendJson(response, 400, { error: 'El usuario debe tener entre 3 y 30 caracteres: letras, números, punto, guion o guion bajo.' });
    }
    if (!EMAIL_PATTERN.test(email)) return sendJson(response, 400, { error: 'Escribe un correo válido.' });
    if (password.length < 8) return sendJson(response, 400, { error: 'La contraseña debe tener al menos 8 caracteres.' });
    if (displayName.length > 60) return sendJson(response, 400, { error: 'El nombre debe tener 60 caracteres o menos.' });
    if (await findUserByUsername(username)) {
      return sendJson(response, 409, { error: 'Ese nombre de usuario ya existe.' });
    }

    let authUser;
    try {
      authUser = await db.createAuthUser({
        email,
        password,
        username,
        displayName: displayName || username,
      });
    } catch (error) {
      if (error.code === 'email_exists' || /already|exists|registered/i.test(error.message)) {
        return sendJson(response, 409, { error: 'Ese correo ya tiene una cuenta. Inicia sesión.' });
      }
      if (error.status === 400 || error.status === 422) {
        return sendJson(response, 400, { error: 'No pudimos crear la cuenta. Revisa el correo y la contraseña.' });
      }
      throw error;
    }

    if (!authUser || !authUser.id) throw new Error('Supabase Auth no devolvió el id de la cuenta creada.');

    try {
      await db.insertRows('users', [{
        id: authUser.id,
        auth_user_id: authUser.id,
        username,
        display_name: displayName || username,
        email,
      }], { returning: false });
    } catch (error) {
      // Si el perfil no se pudo guardar, se borra la cuenta de Auth para no
      // dejar un usuario huérfano que después no pueda registrarse.
      await db.deleteAuthUser(authUser.id).catch(() => {});
      if (/duplicate key|unique constraint/i.test(error.message)) {
        return sendJson(response, 409, { error: 'Ese nombre de usuario ya existe.' });
      }
      throw error;
    }

    return startUserSession(request, response, authUser.id, 201);
  }

  if (pathname === '/api/users/login' && request.method === 'POST') {
    if (isThrottled(request)) return sendJson(response, 429, { error: 'Demasiados intentos fallidos. Espera unos minutos antes de volver a intentarlo.' });
    const body = await readJson(request);
    const identifier = typeof body.username === 'string' && body.username.trim()
      ? body.username.trim()
      : (typeof body.email === 'string' ? body.email.trim() : '');
    const password = typeof body.password === 'string' ? body.password : '';

    if (!identifier || !password) {
      registerFailure(request);
      return sendJson(response, 401, { error: 'Escribe tu usuario o correo y tu contraseña.' });
    }

    let email = '';
    if (identifier.includes('@')) {
      email = identifier.toLowerCase();
    } else {
      const profile = await findUserByUsername(identifier.toLowerCase());
      if (profile) email = (profile.email || '').toLowerCase();
    }

    if (!email) {
      registerFailure(request);
      return sendJson(response, 401, { error: 'El usuario o la contraseña no coinciden.' });
    }

    let auth;
    try {
      auth = await db.signInWithPassword(email, password);
    } catch (error) {
      registerFailure(request);
      if (error.code === 'email_not_confirmed' || /email not confirmed|not confirmed/i.test(error.message)) {
        return sendJson(response, 403, { error: 'Confirma tu correo antes de entrar.' });
      }
      if (error.status && error.status < 500) {
        return sendJson(response, 401, { error: 'El usuario o la contraseña no coinciden.' });
      }
      throw error;
    }

    clearFailures(request);
    const authUser = auth && auth.user ? auth.user : auth;
    if (!authUser || !authUser.id) throw new Error('Supabase Auth no devolvió el usuario al iniciar sesión.');

    let profile = await findUserByAuthId(authUser.id);
    if (!profile) {
      // Cuentas creadas antes de esta migración o directamente desde Supabase.
      profile = await findUserById(authUser.id);
      if (profile) {
        await db.updateRows('users', { id: `eq.${authUser.id}` }, { auth_user_id: authUser.id }, { returning: false });
      }
    }
    if (!profile) profile = await createProfileForAuthUser(authUser);

    return startUserSession(request, response, profile.id, 200);
  }

  if (pathname === '/api/users/logout' && request.method === 'POST') {
    const token = readCookies(request)[USER_COOKIE];
    if (token) await db.deleteRows('user_sessions', { token: `eq.${token}` });
    response.setHeader('Set-Cookie', `${USER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isSecureRequest(request) ? '; Secure' : ''}`);
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === '/api/users/me' && request.method === 'GET') {
    return sendJson(response, 200, await currentUser(request));
  }

  if (pathname === '/api/users/current' && request.method === 'GET') {
    const user = await currentUser(request);
    return sendJson(response, 200, { id: user.id, username: user.username, display_name: user.displayName, email: user.email, guest: user.guest });
  }

  if (pathname === '/api/redemptions' && request.method === 'GET') {
    const user = await currentUser(request);
    const redemptions = await db.selectRows('redemptions', {
      select: 'id,offer_id,user_id,code,created_at',
      filters: { user_id: `eq.${user.id}` },
      order: 'created_at.desc',
    });
    const offerIds = [...new Set(redemptions.map((redemption) => redemption.offer_id))];
    let offersById = new Map();
    if (offerIds.length) {
      const offers = await db.selectRows('offers', {
        select: 'id,brand,brand_initials,brand_color,title',
        filters: { id: `in.(${offerIds.join(',')})` },
      });
      offersById = new Map(offers.map((offer) => [offer.id, offer]));
    }
    return sendJson(response, 200, redemptions.map((redemption) => {
      const offer = offersById.get(redemption.offer_id) || {};
      return {
        id: redemption.id,
        offerId: redemption.offer_id,
        userId: redemption.user_id,
        code: redemption.code,
        createdAt: redemption.created_at,
        offer: {
          brand: offer.brand,
          brand_initials: offer.brand_initials,
          brand_color: offer.brand_color,
          title: offer.title,
        },
      };
    }));
  }

  const viewMatch = pathname.match(/^\/api\/offers\/([\w-]+)\/view$/);
  if (viewMatch && request.method === 'POST') {
    await db.rpc('increment_offer_views', { p_offer_id: viewMatch[1] });
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === '/api/business/register' && request.method === 'POST') {
    if (isThrottled(request)) return sendJson(response, 429, { error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
    const body = await readJson(request);
    const brand = typeof body.brand === 'string' ? body.brand.trim() : '';
    const contact = typeof body.contact === 'string' ? body.contact.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!brand || brand.length > 60) return sendJson(response, 400, { error: 'Indica el nombre de tu negocio.' });
    if (!EMAIL_PATTERN.test(contact)) return sendJson(response, 400, { error: 'Indica un correo de contacto válido.' });
    if (password.length < 8) return sendJson(response, 400, { error: 'La contraseña debe tener al menos 8 caracteres.' });
    if (await findBusiness(brand)) {
      return sendJson(response, 409, { error: 'Ese negocio ya está registrado. Inicia sesión.' });
    }

    const { salt, hash } = hashPassword(password);
    try {
      await db.insertRows('businesses', [{
        brand,
        contact,
        password_salt: salt,
        password_hash: hash,
      }], { returning: false });
    } catch (error) {
      if (/duplicate key|unique constraint/i.test(error.message)) {
        return sendJson(response, 409, { error: 'Ese negocio ya está registrado. Inicia sesión.' });
      }
      throw error;
    }
    return startSession(request, response, brand, 201);
  }

  if (pathname === '/api/business/login' && request.method === 'POST') {
    if (isThrottled(request)) return sendJson(response, 429, { error: 'Demasiados intentos fallidos. Espera unos minutos antes de volver a intentarlo.' });
    const body = await readJson(request);
    const brand = typeof body.brand === 'string' ? body.brand.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const business = await findBusiness(brand);
    if (!business || !verifyPassword(password, business.password_salt, business.password_hash)) {
      registerFailure(request);
      return sendJson(response, 401, { error: 'El negocio o la contraseña no coinciden.' });
    }
    clearFailures(request);
    return startSession(request, response, business.brand, 200);
  }

  if (pathname === '/api/business/logout' && request.method === 'POST') {
    const token = readCookies(request)[SESSION_COOKIE];
    if (token) await db.deleteRows('business_sessions', { token: `eq.${token}` });
    response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isSecureRequest(request) ? '; Secure' : ''}`);
    return sendJson(response, 200, { ok: true });
  }

  if (pathname === '/api/business/me' && request.method === 'GET') {
    const business = await currentBusiness(request);
    if (!business) return sendJson(response, 401, { error: 'No hay ninguna sesión activa.' });
    return sendJson(response, 200, business);
  }

  if (pathname === '/api/business/overview' && request.method === 'GET') {
    const business = await requireBusiness(response, request);
    if (!business) return undefined;

    const rows = await db.selectRows('offers', {
      select: 'id,title,category,discount_label,description,terms,image_url,location,expires_at,views,created_at',
      filters: { active: 'eq.true', brand: `eq.${business.brand}` },
      order: 'created_at.asc,id.asc',
    });

    const counts = new Map();
    if (rows.length) {
      const redemptions = await db.selectRows('redemptions', {
        select: 'offer_id',
        filters: { offer_id: `in.(${rows.map((offer) => offer.id).join(',')})` },
      });
      for (const redemption of redemptions) {
        counts.set(redemption.offer_id, (counts.get(redemption.offer_id) || 0) + 1);
      }
    }

    const totals = {
      offers: rows.length,
      views: rows.reduce((sum, offer) => sum + Number(offer.views || 0), 0),
      redemptions: [...counts.values()].reduce((sum, count) => sum + count, 0),
    };

    const offers = rows.map((offer) => ({
      id: offer.id,
      title: offer.title,
      category: offer.category,
      discountLabel: offer.discount_label,
      description: offer.description,
      terms: offer.terms,
      imageUrl: offer.image_url,
      location: offer.location,
      expiresAt: offer.expires_at,
      views: Number(offer.views || 0),
      redemptions: counts.get(offer.id) || 0,
    }));

    return sendJson(response, 200, { business, totals, offers });
  }

  if (pathname === '/api/business/offers' && request.method === 'POST') {
    const business = await requireBusiness(response, request);
    if (!business) return undefined;
    const body = await readJson(request);
    const fields = readOfferFields(body);
    const validation = validateOfferFields(fields);
    if (validation) return sendJson(response, 400, { error: validation });

    const id = await uniqueOfferId(business.brand);
    await db.insertRows('offers', [{
      id,
      brand: business.brand,
      brand_initials: brandInitials(business.brand),
      brand_color: brandColor(business.brand),
      title: fields.title,
      category: fields.category,
      discount_label: fields.discountLabel,
      description: fields.description,
      terms: fields.terms,
      image_url: fields.imageUrl,
      location: fields.location,
      expires_at: fields.expiresAt,
      featured: false,
      active: true,
    }], { returning: false });

    return sendJson(response, 201, { id, brand: business.brand });
  }

  const businessOfferMatch = pathname.match(/^\/api\/business\/offers\/([\w-]+)$/);
  if (businessOfferMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
    const business = await requireBusiness(response, request);
    if (!business) return undefined;
    const id = businessOfferMatch[1];
    const rows = await db.selectRows('offers', {
      select: '*',
      filters: { id: `eq.${id}`, brand: `eq.${business.brand}`, active: 'eq.true' },
      limit: 1,
    });
    const existing = rows[0];
    if (!existing) return sendJson(response, 404, { error: 'Ese beneficio no existe o no es tuyo.' });

    if (request.method === 'DELETE') {
      await db.updateRows('offers', { id: `eq.${id}` }, { active: false }, { returning: false });
      return sendJson(response, 200, { id, active: false });
    }

    const fields = readOfferFields({ ...existing, ...(await readJson(request)) }, existing);
    const validation = validateOfferFields(fields);
    if (validation) return sendJson(response, 400, { error: validation });

    await db.updateRows('offers', { id: `eq.${id}` }, {
      title: fields.title,
      category: fields.category,
      discount_label: fields.discountLabel,
      description: fields.description,
      terms: fields.terms,
      image_url: fields.imageUrl,
      location: fields.location,
      expires_at: fields.expiresAt,
    }, { returning: false });

    return sendJson(response, 200, { id });
  }

  if (pathname === '/api/subscriptions' && request.method === 'POST') {
    const body = await readJson(request);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || email.length > 160 || !EMAIL_PATTERN.test(email)) {
      return sendJson(response, 400, { error: 'Escribe un correo válido para recibir las ofertas.' });
    }
    const existing = await db.selectRows('subscriptions', {
      select: 'id',
      filters: { email: `eq.${email}` },
      limit: 1,
    });
    if (existing[0]) return sendJson(response, 200, { email, alreadySubscribed: true });
    try {
      const inserted = await db.insertRows('subscriptions', [{ email }]);
      return sendJson(response, 201, { id: inserted[0].id, email, alreadySubscribed: false });
    } catch (error) {
      if (/duplicate key|unique constraint/i.test(error.message)) {
        return sendJson(response, 200, { email, alreadySubscribed: true });
      }
      throw error;
    }
  }

  if (pathname === '/api/offers/top' && request.method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 6, 1), 24);
    const offers = (await db.selectRows('offers', {
      select: 'id,brand,brand_initials,brand_color,title,category,discount_label,description,image_url,location,featured',
      filters: { active: 'eq.true' },
    })).map(toPublicOffer);

    const redemptions = await db.selectRows('redemptions', { select: 'offer_id' });
    const counts = new Map();
    for (const redemption of redemptions) {
      counts.set(redemption.offer_id, (counts.get(redemption.offer_id) || 0) + 1);
    }

    offers.sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0)
      || Number(b.featured) - Number(a.featured)
      || a.brand.localeCompare(b.brand, 'es'));

    return sendJson(response, 200, offers.slice(0, limit).map((offer) => ({
      id: offer.id,
      brand: offer.brand,
      brandInitials: offer.brand_initials,
      brandColor: offer.brand_color,
      title: offer.title,
      category: offer.category,
      discountLabel: offer.discount_label,
      description: offer.description,
      imageUrl: offer.image_url,
      location: offer.location,
      featured: offer.featured,
      redemptions: counts.get(offer.id) || 0,
    })));
  }

  if (pathname === '/api/stats' && request.method === 'GET') {
    const offers = await db.selectRows('offers', {
      select: 'brand,discount_label',
      filters: { active: 'eq.true' },
    });
    const [redemptions, subscribers] = await Promise.all([
      db.countRows('redemptions'),
      db.countRows('subscriptions'),
    ]);

    const percentages = offers
      .map((offer) => {
        const match = String(offer.discount_label).match(/(\d+(?:[.,]\d+)?)\s*%\s*off/i);
        return match ? Number(match[1].replace(',', '.')) : null;
      })
      .filter((value) => Number.isFinite(value));

    const averageDiscount = percentages.length
      ? Math.round(percentages.reduce((sum, value) => sum + value, 0) / percentages.length)
      : 0;
    const maxDiscount = percentages.length ? Math.round(Math.max(...percentages)) : 0;
    const hasTwoForOne = offers.some((offer) => /2\s*x/i.test(offer.discount_label));
    const hasFree = offers.some((offer) => /gratis/i.test(offer.discount_label));

    return sendJson(response, 200, {
      offers: offers.length,
      redemptions,
      subscribers,
      businesses: new Set(offers.map((offer) => offer.brand)).size,
      averageDiscount,
      maxDiscount,
      hasTwoForOne,
      hasFree,
    });
  }

  if (pathname === '/api/health' && request.method === 'GET') {
    try {
      await db.selectRows('offers', { select: 'id', limit: 1 });
      return sendJson(response, 200, { status: 'ok', database: 'supabase' });
    } catch (error) {
      console.error('Health check:', error.message);
      return sendJson(response, 503, { status: 'error', database: 'supabase' });
    }
  }

  return sendJson(response, 404, { error: 'Ruta de API no encontrada.' });
}

/* ---------- Archivos estáticos ---------- */

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    return response.end('Solicitud inválida');
  }

  const relativePath = decodedPath === '/' ? 'buenplan.html' : decodedPath.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403);
    return response.end('Prohibido');
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return response.end('No encontrado');
    }
    const etag = `"${createHash('sha1').update(contents).digest('base64url')}"`;
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { ETag: etag });
      return response.end();
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
  });
}

/* ---------- Servidor ---------- */

const handler = async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(request, response, url);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error(error);
      sendJson(response, status, {
        error: status >= 500
          ? 'No pudimos conectar con la base de datos. Inténtalo de nuevo en un momento.'
          : error.message,
      });
    }
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    return response.end();
  }
  serveStatic(request, response, url.pathname);
};

const TLS_KEY = process.env.TLS_KEY_PATH;
const TLS_CERT = process.env.TLS_CERT_PATH;
const server = TLS_KEY && TLS_CERT
  ? https.createServer({ key: fs.readFileSync(TLS_KEY), cert: fs.readFileSync(TLS_CERT) }, handler)
  : http.createServer(handler);

/** Crea el perfil visitante si es la primera vez que se usa el proyecto. */
async function ensureGuestUser() {
  const guest = await findUserById(DEFAULT_USER_ID);
  if (guest) return;
  try {
    await db.insertRows('users', [{
      id: DEFAULT_USER_ID,
      username: DEFAULT_USER_ID,
      display_name: 'Mocab',
    }], { returning: false });
  } catch (error) {
    if (!/duplicate key|unique constraint/i.test(error.message)) throw error;
  }
}

async function start() {
  db.assertSupabaseConfig();
  await ensureGuestUser();
  void purgeExpiredSessions();

  const catalogCount = await db.countRows('offers', { active: 'eq.true' });
  if (catalogCount === 0) {
    console.log('El catálogo está vacío. Carga tus negocios con: node importar-socios.mjs');
  }

  server.listen(PORT, () => {
    const scheme = TLS_KEY && TLS_CERT ? 'https' : 'http';
    const note = TLS_KEY && TLS_CERT ? ' (HTTPS activo, la cookie de sesión usa Secure)' : '';
    console.log(`BuenPlan está listo en ${scheme}://localhost:${PORT}${note}`);
    console.log('Base de datos: Supabase');
  });
}

start().catch((error) => {
  console.error('No se pudo iniciar BuenPlan:', error.message);
  if (/Could not find the table|does not exist|42P01/i.test(error.message)) {
    console.error('Ejecuta supabase/schema.sql completo en el SQL Editor del proyecto.');
  } else if (/No se pudo conectar|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(error.message)) {
    console.error('Revisa SUPABASE_URL y tu conexión a internet.');
  }
  process.exit(1);
});

function closeServer() {
  server.close(() => {
    process.exit(0);
  });
}
process.on('SIGINT', closeServer);
process.on('SIGTERM', closeServer);
