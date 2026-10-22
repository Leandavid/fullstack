# BuenPlan

Catálogo para clientes de descuentos y beneficios. Incluye interfaz responsive, API REST en Node.js y persistencia en Supabase (Postgres), sin dependencias npm externas.

## Cómo está conectado

```
public/ (HTML, CSS, JS)
        │  fetch a /api/...
        ▼
server.js (API REST + sesiones HttpOnly)
        │  REST de Supabase (service_role)
        │  Supabase Auth (registro y login de clientes)
        ▼
Supabase (Postgres + Auth + RLS)
```

El frontend **nunca** habla directo con Supabase: todas las consultas pasan por `server.js`. Las cuentas de clientes viven en **Supabase Auth**; el backend guarda el perfil público en `public.users` y mantiene su propia cookie de sesión `HttpOnly`. La `service_role` y la `anon key` se usan solo en el servidor.

## Requisitos

- Node.js 22.5 o superior (recomendado Node.js 24).

## Configurar Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. Abre **SQL Editor**, pega el contenido completo de [`supabase/schema.sql`](supabase/schema.sql) y ejecútalo. Eso crea las tablas, índices, RLS y la función que cuenta visitas.
3. Ve a **Project Settings → API** y copia:
   - **Project URL**
   - **anon key** (se usa para validar el login de clientes)
   - **service_role key** (no la `anon` / `publishable` para esta variable)
4. Copia `.env.example` como `.env` y completa las credenciales:

   ```powershell
   Copy-Item .env.example .env
   ```

   ```dotenv
   SUPABASE_URL=https://tu-proyecto.supabase.co
   SUPABASE_ANON_KEY=pega-aqui-la-anon-key
   SUPABASE_SERVICE_ROLE_KEY=pega-aqui-la-service-role-key
   ```

5. Ejecuta la app:

   ```powershell
   npm start
   ```

Abre [http://localhost:3000](http://localhost:3000). Para desarrollo con reinicio automático:

```powershell
npm run dev
```

Comprueba la conexión en [http://localhost:3000/api/health](http://localhost:3000/api/health): debe responder `{"status":"ok","database":"supabase"}`.

> `.env` está en `.gitignore`. Nunca subas la `service_role` a Git ni la uses en el navegador. Si se filtró, regenérala en Supabase.

## Cargar negocios socios

> El repositorio incluye **27 beneficios de demostración** en `data/socios.csv` (negocios y fotos de ejemplo) para que el catálogo y el diseño se vean completos desde el primer arranque. Reemplazalos por acuerdos reales antes de publicar el sitio.

El catálogo se carga desde `data/socios.csv` con los negocios con los que tienes acuerdo:

```powershell
node importar-socios.mjs
```

El formato de cada columna está en [data/SOCIOS.md](data/SOCIOS.md). El importador valida el archivo, escribe directo en Supabase y no necesita reiniciar el servidor. Por omisión **agrega o actualiza** los beneficios del CSV y deja intacto lo demás. Para reemplazar el catálogo completo:

```powershell
node importar-socios.mjs --reset
```

`--reset` borra también los canjes asociados, así que úsalo solo cuando estés empezando. Si el catálogo está vacío, la página lo indica y no inventa ofertas de ejemplo.

## Variables de entorno

| Variable | Efecto |
| --- | --- |
| `SUPABASE_URL` | URL https del proyecto Supabase. |
| `SUPABASE_ANON_KEY` | Clave pública, usada por el backend para validar correo y contraseña en Supabase Auth. |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave privada del servidor. Obligatoria. |
| `PORT` | Puerto del servidor (3000 por defecto). |
| `SECURE_COOKIES` | `1` fuerza la cookie de sesión con `Secure`, `0` la omite. Sin valor se decide según HTTPS o `X-Forwarded-Proto`. |
| `TLS_KEY_PATH` | Ruta a la clave privada PEM. Si se define junto con `TLS_CERT_PATH`, el servidor arranca con HTTPS. |
| `TLS_CERT_PATH` | Ruta al certificado PEM. |

## Cuentas e HTTPS

Los usuarios se registran desde la página principal (botón junto al avatar). El registro crea la cuenta en **Supabase Auth** y un perfil en `public.users`. Se puede entrar con el **usuario o con el correo** y la contraseña. Los códigos de canje se guardan en Supabase, así que se ven desde cualquier dispositivo. Sin sesión, BuenPlan usa el perfil visitante `mocab`, que es una identidad de desarrollo sin cuenta.

- La contraseña la administra Supabase Auth; el backend no guarda hashes de usuarios.
- Al registrarse, la cuenta se crea con el correo confirmado para que se pueda usar de inmediato.
- La sesión sigue siendo una cookie `HttpOnly` de 7 días emitida por el backend (`bp_user`). El navegador nunca recibe tokens de Supabase.
- Los negocios conservan su propio acceso con contraseña `scrypt` y cookie `bp_session`, porque son cuentas operativas separadas de los clientes.

> Si ya tenías cuentas creadas con el sistema anterior, no se pueden migrar automáticamente porque las contraseñas estaban hasheadas con `scrypt`. Volvé a registrarte con el mismo correo. Si el nombre de usuario viejo te bloquea el registro, borrá esa fila en `public.users` (la que tiene `auth_user_id` en `null`) desde Supabase. El correo de confirmación y el restablecimiento de contraseña todavía no tienen pantalla en la app; se gestionan desde Supabase.

Para servir por HTTPS:

```powershell
$env:TLS_KEY_PATH = "C:\ruta\privada.pem"
$env:TLS_CERT_PATH = "C:\ruta\certificado.pem"
npm start
```

Con HTTPS activo la cookie sale con `Secure` automáticamente.

## API

| Método | Ruta | Descripción |
| --- | --- | --- |
| `GET` | `/api/health` | Estado del servidor y de Supabase |
| `GET` | `/api/offers` | Lista beneficios; acepta `category` y `search` |
| `GET` | `/api/offers/categories` | Categorías disponibles y cantidad de ofertas |
| `GET` | `/api/offers/top` | Marcas ordenadas por canjes; acepta `limit` (1–24, por defecto 6) |
| `GET` | `/api/users/current` | Perfil local activo (`mocab`) |
| `GET` | `/api/users/me` | Usuario de la sesión; si no hay, el visitante `mocab` |
| `POST` | `/api/users/register` | Crea la cuenta en Supabase Auth y su perfil; hereda los canjes del visitante |
| `POST` | `/api/users/login` | Valida usuario o correo y contraseña con Supabase Auth; cookie `bp_user` |
| `POST` | `/api/users/logout` | Cierra la sesión de usuario |
| `GET` | `/api/redemptions` | Canjes asociados al usuario activo |
| `POST` | `/api/redemptions` | Genera y persiste un código asociado al usuario activo |
| `GET` | `/api/stats` | Cifras de la landing: ofertas, canjes, negocios, suscriptores, descuento promedio y máximo |
| `POST` | `/api/subscriptions` | Registra un correo en la lista de avisos; responde `alreadySubscribed` si ya estaba |
| `POST` | `/api/offers/:id/view` | Suma una visita al beneficio; lo llama el catálogo al abrir la ficha |
| `GET` | `/api/business/overview` | Estadísticas y beneficios del negocio con sesión activa |
| `POST` | `/api/business/register` | Crea un negocio con contraseña e inicia sesión |
| `POST` | `/api/business/login` | Inicia sesión; devuelve una cookie `bp_session` |
| `POST` | `/api/business/logout` | Cierra la sesión y borra la cookie |
| `GET` | `/api/business/me` | Devuelve el negocio de la sesión actual |
| `POST` | `/api/business/offers` | Publica un beneficio a nombre del negocio con sesión |
| `PATCH` | `/api/business/offers/:id` | Edita un beneficio propio |
| `DELETE` | `/api/business/offers/:id` | Retira un beneficio propio del catálogo (`active = false`) |

Ejemplo de canje:

```json
{
  "offerId": "laurel-cafe"
}
```

La interfaz conserva una copia local de los canjes en el navegador para mostrarlos si se cae la API, pero la fuente de verdad es Supabase. El perfil local `mocab` es una identidad de desarrollo; no tiene contraseña ni autentica sesiones.

## Panel de negocios

`/negocios.html` pide registro o inicio de sesión y, dentro, muestra las estadísticas del negocio (beneficios, visitas y canjes), permite publicar, editar y quitar beneficios.

- Contraseñas con `scrypt` y sal por negocio; comparación con `timingSafeEqual`.
- Sesión por cookie `bp_session` (`HttpOnly`, `SameSite=Lax`) válida 7 días, guardada en `business_sessions`.
- Cada beneficio se valida por pertenencia: un negocio no puede editar ni quitar beneficios de otro (responde 404).
- Quitar un beneficio es un borrado lógico: se marca `active = false` y desaparece del catálogo.

El campo `verified` de la tabla `businesses` existe y se muestra en el panel, pero no hay interfaz para activarlo: se marca a mano desde Supabase cuando BuenPlan valida al negocio.

## Seguridad de la base de datos

- Las tablas tienen **RLS activado y ninguna política pública**: `anon` y `authenticated` no pueden leer ni escribir.
- El backend usa la `service_role`, que salta RLS y solo existe en el servidor.
- Las contraseñas de clientes las administra **Supabase Auth**; `public.users` solo guarda el perfil público.
- La única tabla con contraseña propia es `businesses`, con `scrypt` y sal por negocio.
- La función `increment_offer_views` es `security definer` y solo tiene permiso de ejecución para `service_role`.
- Los formularios de acceso tienen límite de intentos fallidos por IP.
- Las sesiones del backend son cookies `HttpOnly`; el navegador no recibe tokens de Supabase.

## Problemas frecuentes

| Síntoma | Causa y solución |
| --- | --- |
| `Faltan las credenciales de Supabase` | No existe `.env` o está incompleto. Copia `.env.example`. |
| `La clave configurada es pública (anon)` | En `SUPABASE_SERVICE_ROLE_KEY` usaste la clave equivocada; copia la `service_role`. |
| `Could not find the table` | Falta ejecutar `supabase/schema.sql` en el SQL Editor. |
| `/api/health` responde 503 | La URL, la clave o el esquema no están bien; revisa la consola del servidor. |
| `Ese correo ya tiene una cuenta` | Ese email ya está en Supabase Auth. Inicia sesión o restablece la contraseña desde Supabase. |
| `El usuario o la contraseña no coinciden` con una cuenta vieja | Las cuentas del sistema anterior no se migran; vuelve a registrarte. |
| `Confirma tu correo antes de entrar` | La cuenta se creó desde el panel de Supabase sin confirmar el email; confírmalo o crea la cuenta desde la app. |
| El catálogo está vacío | Carga `data/socios.csv` con `node importar-socios.mjs`. |

La base SQLite anterior (`data/buenplan.db`) ya no se usa. Si tenías cuentas o canjes locales, vuelve a cargar los negocios desde el CSV: las cuentas y canjes de prueba no se migran automáticamente.
