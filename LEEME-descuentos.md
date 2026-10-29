# Descuentos por hora — stays-proxy

Este módulo baja precios automáticamente según **cuántos días faltan para la llegada** y **la hora del día**, solo en noches que siguen libres.

## Archivos

| Archivo | Qué es |
|---|---|
| `scheduler.js` | El reloj y la lógica de descuentos (nuevo). |
| `rules.json` | Las unidades, sus pisos y las reglas por sector. **Se edita aquí.** |
| `server.js` | El proxy de siempre, más: carga el módulo y exige clave en `/apply-discount` y `/apply-batch`. |
| `server.original.js` | Copia del `server.js` anterior, por si hay que volver atrás. |

## Cómo funciona

- Cada 15 minutos (hora de Chile) revisa las unidades de `rules.json` para hoy y los próximos 7 días.
- Para cada noche **disponible** busca la regla que corresponde (días antes + hora) y calcula el precio nuevo sobre el **precio original del día**: −12% y luego −20% no se suman.
- Dentro de una misma noche el descuento solo puede profundizarse; no reescribe el mismo precio cada 15 minutos.
- Nunca baja del `floor` (piso) de la unidad.
- Si el precio de la noche cambia por fuera (por ejemplo, PriceLabs sincroniza), toma ese precio como la nueva base.
- Escribe el precio con `POST /external/v1/price/sells` (tipo `event`), el mismo endpoint que ya usaba el proxy.
- Guarda estado y registro en `DATA_DIR` (`auto-state.json`, `auto-log.jsonl`).

## Unidades y reglas de la prueba

Todo en **USD**, la moneda de las tarifas en Stays. El precio final se redondea al dólar entero (`roundTo` en `rules.json`).

| Unidad | Perfil | Mismo día | Día anterior | 2–4 días | Piso |
|---|---|---|---|---|---|
| CN-127 | costa | −12% desde 10:00 · −20% desde 15:00 | −10% desde 15:00 | −6% mar/mié, solo llegadas de viernes | US$56 |
| VM-126 (R) | costa | igual | igual | igual | US$75 |
| STGO-26 | santiago_centro | −10% desde 09:00 · −18% desde 14:00 | −8% desde 16:00 | — | US$30 |
| STGO-15 | las_condes | −8% desde 14:00 | — | — | $52.000 |

## Desplegar en Railway

1. Subir estos archivos al servicio `stays-proxy-production` (o al repositorio que Railway despliega).
2. En **Variables** del servicio agregar:
   - `ADMIN_TOKEN` = una clave larga que solo conozca el equipo.
   - `AUTO_ENABLED=false` y `AUTO_DRY_RUN=true` (arranca apagado y en simulación).
   - `DATA_DIR=/data` y crear un **Volume** montado en `/data`, para que el estado sobreviva a reinicios.
   - Revisar que `STAYS_CLIENT_ID` y `STAYS_CLIENT_SECRET` sigan configuradas (si se compartieron alguna vez por chat, renovarlas en Stays).
3. Desplegar y abrir `https://stays-proxy-production.up.railway.app/auto/status?token=TU_CLAVE`.

## Plan de prueba

**Paso 1 · Verificar lectura (sin tocar precios)**
- `GET /diag/listings?token=…` → deben aparecer `CN-127`, `VM-126 (R)`, `STGO-26` y `STGO-15` con su ID.
- `GET /diag/calendar?token=…&unit=CN-127&from=AAAA-MM-DD&to=AAAA-MM-DD` → debe traer `avail` y el precio en USD de esa noche.
- `GET /auto/preview?token=…&at=2026-10-30T15:00` → muestra qué haría a esa hora, sin escribir nada.

**Paso 2 · Simulación 2–3 días**
- `POST /auto/config` con header `x-admin-token: TU_CLAVE` y cuerpo `{"enabled": true, "dryRun": true}`.
- Revisar `GET /auto/log?token=…`: cada entrada `simulado` dice unidad, fecha, precio base, % y precio nuevo.

**Paso 3 · Una escritura controlada**
- Antes de activar todo, probar una sola noche con `POST /apply-discount` (ahora pide la clave) en una fecha libre de una unidad de prueba, y confirmar en Stays (calendario) y en Airbnb que el precio cambió y en cuánto tiempo.
- Confirmar si `to` es la noche incluida o el día de salida. Si Stays lo trata como salida, poner `SELL_TO_INCLUSIVE=false`.

**Paso 4 · Activar**
- `POST /auto/config` con `{"enabled": true, "dryRun": false}`.
- Para apagar todo de inmediato: `{"enabled": false}`.

## Puntos a confirmar en la prueba real

- **PriceLabs**: si tiene syncs durante el día para estas unidades, puede pisar el descuento. El módulo lo detecta como "precio cambió por fuera" y vuelve a aplicar el % sobre el precio nuevo en el siguiente ciclo.
- **Precio `event` en Stays**: si una noche vuelve a quedar libre después de un descuento (por ejemplo, una cancelación al día siguiente), el precio de evento sigue vigente para esa fecha. Revisar en la prueba cómo se borra un precio de evento en Stays, si hace falta.
- **Formato del calendario**: el módulo lee `avail` y `prices[0]._mcval.USD`. Si `/diag/calendar` muestra otra forma, hay que ajustar `extractDay` en `scheduler.js`.

## Endpoints

Todos piden `?token=` o el header `x-admin-token`.

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/auto/status` | Estado, reglas y noches ya tocadas |
| GET | `/auto/log` | Últimos cambios (`?limit=200`) |
| GET | `/auto/preview` | Qué haría ahora o a una hora (`?at=AAAA-MM-DDTHH:MM`) |
| POST | `/auto/run` | Corre un ciclo ahora |
| POST | `/auto/config` | `{"enabled": bool, "dryRun": bool}` |
| POST | `/auto/reset-night` | `{"unit","date"}` olvida una noche |
| GET | `/diag/listings` | Nombre interno → ID de Stays |
| GET | `/diag/calendar` | Calendario crudo de una unidad |
