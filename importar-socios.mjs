import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(ROOT, '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const { default: db } = await import(pathToFileURL(join(ROOT, 'lib', 'supabase.js')).href);

const CSV_PATH = join(ROOT, 'data', 'socios.csv');
const reset = process.argv.includes('--reset');

try {
  db.assertSupabaseConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const HEADERS = ['id', 'brand', 'brand_initials', 'brand_color', 'title', 'category', 'discount_label', 'description', 'terms', 'image_url', 'location', 'expires_at', 'featured'];

/** Separador `;` con soporte de comillas dobles, como en un CSV normal. */
function parseLine(line) {
  const values = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === '"' && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        current += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ';') {
      values.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  values.push(current);
  return values.map((value) => value.trim());
}

function validate(row, lineNumber, problems) {
  for (const field of ['id', 'brand', 'brand_initials', 'brand_color', 'title', 'category', 'discount_label', 'description', 'terms', 'image_url', 'location', 'expires_at']) {
    if (!row[field]) problems.push(`línea ${lineNumber}: falta ${field}`);
  }
  if (row.id && !/^[a-z0-9-]+$/.test(row.id)) problems.push(`línea ${lineNumber}: el id debe ir en minúsculas y con guiones (${row.id})`);
  if (row.brand_color && !/^#[0-9a-fA-F]{6}$/.test(row.brand_color)) problems.push(`línea ${lineNumber}: brand_color debe ser un hexadecimal tipo #e9d7b4`);
  if (row.image_url && !/^https?:\/\/\S+$/i.test(row.image_url)) problems.push(`línea ${lineNumber}: image_url debe empezar con http:// o https://`);
  if (row.expires_at && !/^\d{4}-\d{2}-\d{2}$/.test(row.expires_at)) problems.push(`línea ${lineNumber}: expires_at debe tener el formato AAAA-MM-DD`);
  if (row.description && row.description.length > 400) problems.push(`línea ${lineNumber}: description supera los 400 caracteres`);
  if (row.terms && row.terms.length > 600) problems.push(`línea ${lineNumber}: terms supera los 600 caracteres`);
  if (!['0', '1', ''].includes(row.featured)) problems.push(`línea ${lineNumber}: featured debe ser 0 o 1`);
}

const lines = readFileSync(CSV_PATH, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

if (lines.length < 2) {
  console.error('El archivo está vacío o solo tiene el encabezado.');
  process.exit(1);
}

const header = parseLine(lines[0]);
if (header.join(',') !== HEADERS.join(',')) {
  console.error('El encabezado no coincide con el formato esperado.');
  console.error('Esperado:', HEADERS.join(';'));
  console.error('Encontrado:', header.join(';'));
  process.exit(1);
}

const problems = [];
const rows = lines.slice(1).map((line, index) => {
  const row = Object.fromEntries(parseLine(line).map((value, column) => [HEADERS[column], value]));
  validate(row, index + 2, problems);
  return row;
});

const seen = new Set();
for (const row of rows) {
  if (seen.has(row.id)) problems.push(`el id "${row.id}" está repetido`);
  seen.add(row.id);
}

if (problems.length) {
  console.error('No se cargó nada. Corrige estos problemas:\n');
  for (const problem of problems) console.error(' -', problem);
  process.exit(1);
}

try {
  if (reset) {
    await db.deleteRows('redemptions', { id: 'not.is.null' });
    await db.deleteRows('offers', { id: 'not.is.null' });
    console.log('Catálogo anterior eliminado de Supabase.');
  }

  await db.insertRows('offers', rows.map((row) => ({
    id: row.id,
    brand: row.brand,
    brand_initials: row.brand_initials,
    brand_color: row.brand_color,
    title: row.title,
    category: row.category,
    discount_label: row.discount_label,
    description: row.description,
    terms: row.terms,
    image_url: row.image_url,
    location: row.location,
    expires_at: row.expires_at,
    featured: row.featured === '1',
    active: true,
  })), { onConflict: 'id', returning: false });

  const total = await db.countRows('offers', { active: 'eq.true' });
  const categoryRows = await db.selectRows('offers', { select: 'category', filters: { active: 'eq.true' } });
  const counts = new Map();
  for (const row of categoryRows) counts.set(row.category, (counts.get(row.category) || 0) + 1);
  const categories = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b, 'es'));

  console.log(`${rows.length} beneficios cargados en Supabase. El catálogo activo tiene ${total}.`);
  console.log('Categorías:', categories.map(([category, count]) => `${category} (${count})`).join(', '));
  console.log('Los cambios ya se ven en la página; no hace falta reiniciar el servidor.');
} catch (error) {
  console.error('No se pudo cargar el catálogo en Supabase:', error.message);
  if (/Could not find the table|does not exist|42P01/i.test(error.message)) {
    console.error('Ejecuta supabase/schema.sql completo en el SQL Editor del proyecto.');
  } else if (/No se pudo conectar|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(error.message)) {
    console.error('Revisa SUPABASE_URL y tu conexión a internet.');
  }
  process.exit(1);
}
