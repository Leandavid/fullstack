/**
 * Acceso a Supabase desde el servidor usando la API REST (PostgREST).
 *
 * La clave `service_role` nunca debe llegar al navegador: este módulo solo se
 * carga desde server.js y desde el importador de socios. Las tablas tienen RLS
 * activado y ninguna política pública, así que solo esta clave puede leerlas.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const SUPABASE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '').trim();
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || '').trim();

/** Detecta si la clave es pública (anon) para frenar una configuración insegura. */
function keyRole(key) {
  if (key.startsWith('sb_secret_')) return 'service_role';
  if (key.startsWith('sb_publishable_')) return 'anon';
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      return payload.role || null;
    } catch {
      return null;
    }
  }
  return null;
}

function assertSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      'Faltan las credenciales de Supabase. Copia .env.example a .env y completa SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
  if (!/^https:\/\/.+/i.test(SUPABASE_URL) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(SUPABASE_URL)) {
    throw new Error('SUPABASE_URL debe ser la URL https del proyecto, por ejemplo https://abcdefgh.supabase.co');
  }
  if (keyRole(SUPABASE_KEY) === 'anon') {
    throw new Error(
      'La clave configurada es pública (anon). Usa la service_role key en SUPABASE_SERVICE_ROLE_KEY: el backend la necesita para saltar RLS, y nunca debe exponerse en el frontend.',
    );
  }
}

function buildQuery(query) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, String(value));
  }
  return search.toString();
}

async function supabaseFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (cause) {
    throw Object.assign(new Error(`No se pudo conectar con Supabase: ${cause.message}`), { status: 502, supabase: true });
  }
}

async function request(path, { method = 'GET', query, body, prefer, headers = {} } = {}) {
  const queryString = query ? buildQuery(query) : '';
  const url = `${SUPABASE_URL}/rest/v1/${path}${queryString ? `?${queryString}` : ''}`;
  const response = await supabaseFetch(url, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload.message || payload.details || payload.hint || JSON.stringify(payload);
    } catch {
      detail = await response.text().catch(() => '');
    }
    const error = new Error(`Supabase respondió ${response.status}${detail ? `: ${detail}` : ''}`);
    error.status = 502;
    error.supabase = true;
    throw error;
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Lee filas de una tabla.
 * `filters` usa la sintaxis de PostgREST, por ejemplo { active: 'eq.true' }.
 */
async function selectRows(table, { select = '*', filters = {}, order, limit, offset } = {}) {
  const rows = await request(table, {
    query: { select, order, limit, offset, ...filters },
  });
  return Array.isArray(rows) ? rows : [];
}

async function insertRows(table, rows, { onConflict, returning = true } = {}) {
  const prefer = returning ? 'return=representation' : 'return=minimal';
  return request(table, {
    method: 'POST',
    query: onConflict ? { on_conflict: onConflict } : undefined,
    body: rows,
    prefer: onConflict ? `${prefer},resolution=merge-duplicates` : prefer,
  });
}

async function updateRows(table, filters, values, { returning = true } = {}) {
  return request(table, {
    method: 'PATCH',
    query: filters,
    body: values,
    prefer: returning ? 'return=representation' : 'return=minimal',
  });
}

async function deleteRows(table, filters) {
  return request(table, {
    method: 'DELETE',
    query: filters,
    prefer: 'return=minimal',
  });
}

/** Cuenta filas sin traerlas, usando la cabecera Content-Range de PostgREST. */
async function countRows(table, filters = {}) {
  const queryString = buildQuery(filters);
  const response = await supabaseFetch(`${SUPABASE_URL}/rest/v1/${table}${queryString ? `?${queryString}` : ''}`, {
    method: 'HEAD',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: 'count=exact',
    },
  });
  if (!response.ok) {
    throw Object.assign(new Error(`Supabase respondió ${response.status} al contar ${table}.`), { status: 502, supabase: true });
  }
  const range = response.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

async function rpc(fn, args = {}) {
  return request(`rpc/${fn}`, { method: 'POST', body: args });
}

/* ---------- Supabase Auth ---------- */

async function authRequest(path, { method = 'POST', body, admin = false } = {}) {
  const key = admin ? SUPABASE_KEY : (SUPABASE_ANON_KEY || SUPABASE_KEY);
  const response = await supabaseFetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    const detail = payload.msg || payload.message || payload.error_description || payload.error || '';
    const error = new Error(`Supabase Auth respondió ${response.status}${detail ? `: ${detail}` : ''}`);
    error.status = response.status;
    error.auth = true;
    error.code = payload.error_code || payload.error || '';
    throw error;
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

/** Crea la cuenta en Supabase Auth con la service_role; el correo queda confirmado. */
async function createAuthUser({ email, password, username, displayName }) {
  const payload = await authRequest('admin/users', {
    method: 'POST',
    admin: true,
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: {
        username,
        display_name: displayName,
      },
    },
  });
  return payload && payload.user ? payload.user : payload;
}

async function deleteAuthUser(id) {
  return authRequest(`admin/users/${encodeURIComponent(id)}`, { method: 'DELETE', admin: true });
}

/** Valida correo y contraseña contra Supabase Auth. */
async function signInWithPassword(email, password) {
  return authRequest('token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
}

module.exports = {
  assertSupabaseConfig,
  selectRows,
  insertRows,
  updateRows,
  deleteRows,
  countRows,
  rpc,
  createAuthUser,
  deleteAuthUser,
  signInWithPassword,
};
