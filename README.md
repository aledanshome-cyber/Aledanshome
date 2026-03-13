# Aledans Home — Servidor de Webhooks Shopify→Supabase

## ¿Qué hace este servidor?

Recibe notificaciones automáticas de Shopify y actualiza Supabase en tiempo real:

| Evento Shopify | Acción en Supabase |
|---|---|
| Orden pagada | Descuenta `stock_online` + registra venta |
| Orden cancelada | Devuelve stock al inventario |
| Producto editado en Shopify | Actualiza `pshopify` (precio) |

---

## Paso 1 — Subir a GitHub

1. Crea una cuenta en https://github.com (gratis)
2. Crea un repositorio nuevo llamado `aledans-webhook`
3. Sube los 3 archivos: `server.js`, `package.json`, `.env.example`

---

## Paso 2 — Deploy en Render (gratis)

1. Ve a https://render.com → crear cuenta gratis
2. **New** → **Web Service**
3. Conecta tu repositorio de GitHub `aledans-webhook`
4. Configuración:
   - **Name:** `aledans-webhook`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free

5. En **Environment Variables** agrega estas 3 variables:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | `https://jektsminihhmuyhmiyid.supabase.co` |
| `SUPABASE_SERVICE_KEY` | (ver Paso 3 abajo) |
| `SHOPIFY_WEBHOOK_SECRET` | (ver Paso 4 abajo) |

6. Clic en **Create Web Service**
7. Render te da una URL como: `https://aledans-webhook.onrender.com`

---

## Paso 3 — Obtener Service Role Key de Supabase

1. Ve a https://supabase.com → tu proyecto
2. Settings → API
3. Copia la key que dice **service_role** (NO la anon)
4. Pégala en Render como `SUPABASE_SERVICE_KEY`

⚠️ Esta key tiene acceso total — nunca la pongas en el frontend

---

## Paso 4 — Crear Webhooks en Shopify

1. Ve a tu admin Shopify → **Configuración** → **Notificaciones**
2. Baja hasta **Webhooks** → **Crear webhook**
3. Crea estos 3 webhooks:

| Evento | URL |
|--------|-----|
| Pago de pedido | `https://aledans-webhook.onrender.com/webhook/orders/paid` |
| Cancelación de pedido | `https://aledans-webhook.onrender.com/webhook/orders/cancelled` |
| Actualización de producto | `https://aledans-webhook.onrender.com/webhook/products/update` |

4. Formato: **JSON**
5. Al crear el primer webhook, Shopify te muestra el **Signing secret**
   → Cópialo y ponlo en Render como `SHOPIFY_WEBHOOK_SECRET`

---

## Paso 5 — Verificar que funciona

Abre en tu navegador:
```
https://aledans-webhook.onrender.com
```

Debe responder:
```json
{
  "status": "ok",
  "service": "Aledans Home — Shopify Webhook Server"
}
```

---

## Flujo completo funcionando

```
Cliente compra en Shopify
        ↓
Shopify envía webhook a Render
        ↓
Render verifica firma y procesa
        ↓
Supabase actualiza stock_online
        ↓
App Aledans Home se actualiza en tiempo real ✅
```
