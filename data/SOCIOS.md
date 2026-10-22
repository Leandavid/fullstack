# Cargar negocios socios

`data/socios.csv` es el archivo donde declaras los negocios con los que tienes acuerdo y el descuento que ofrecen. Está separado del código: cuando cambies una promoción, editas el CSV y recargas, sin tocar JavaScript.

## Formato

Una fila por beneficio. Los campos van separados por `;` y los textos que contengan `;` deben ir entre comillas.

| Columna | Qué es | Obligatorio |
| --- | --- | --- |
| `id` | Identificador corto y único, en minúsculas y con guiones (`laurel-cafe`). | Sí |
| `brand` | Nombre del negocio tal como quieres que se vea. | Sí |
| `brand_initials` | Iniciales del avatar (2 letras). | Sí |
| `brand_color` | Color del avatar en hexadecimal (`#e9d7b4`). | Sí |
| `title` | Frase del beneficio, corta y con gancho. | Sí |
| `category` | Categoría del catálogo. Las existentes: Gastronomía, Bienestar, Compras, Experiencias, Viajes. | Sí |
| `discount_label` | El descuento tal como se muestra: `2 x 1`, `20% OFF`, `GRATIS`. | Sí |
| `description` | Qué incluye y por qué conviene. Máximo 400 caracteres. | Sí |
| `terms` | Condiciones reales: días, horarios, monto o producto. Máximo 600. Se muestra tal cual, sin abreviar. | Sí |
| `image_url` | URL de la foto. | Sí |
| `location` | Dónde aplica: sucursal, zona o `En línea y tienda`. | Sí |
| `expires_at` | Fecha de vigencia en formato `AAAA-MM-DD`. | Sí |
| `featured` | `1` para que salga en la sección de destacados, `0` si no. | No |

## Cargar

```powershell
node importar-socios.mjs
```

El importador valida el archivo y escribe directo en Supabase, usando las mismas credenciales de `.env` que el servidor. Por omisión **agrega o actualiza** lo que haya en el CSV y deja intacto lo demás. Para reemplazar el catálogo completo:

```powershell
node importar-socios.mjs --reset
```

`--reset` borra también los canjes asociados a los beneficios que elimina, así que úsalo solo cuando estés empezando.

## Recomendaciones para las condiciones

La REFCO puede sancionar la publicidad engañosa, y un beneficio sin condiciones claras es justo eso. En `terms` escribe lo que de verdad aplica:

- **Qué días y horarios** funcionan, no solo "válido siempre".
- **Qué queda fuera**: bebidas, productos premium, días festivos.
- **Si no es acumulable**, dilo.
- **Si hay un monto mínimo**, ponlo.

Un beneficio honesto y acotado convence más que uno grande y ambiguo.