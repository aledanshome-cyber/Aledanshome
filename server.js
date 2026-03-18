const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const { createClient } = require('@supabase/supabase-js');

const app = express();

const SHOPIFY_SECRET   = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_STORE    = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN    = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_LOCATION = process.env.SHOPIFY_LOCATION_ID;
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID     || 'af32f57d2db0269fa35da09a3af581c8';
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || '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';
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY;
const PORT             = process.env.PORT || 3000;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

function verifyShopify(rawBody, hmacHeader) {
  if (!SHOPIFY_SECRET) return true;
  const digest = crypto.createHmac('sha256', SHOPIFY_SECRET).update(rawBody).digest('base64');
  return digest === hmacHeader;
}

function shopifyRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    if (!SHOPIFY_TOKEN || !SHOPIFY_STORE) return resolve({ skipped: true });
    const options = {
      hostname: SHOPIFY_STORE,
      path: `/admin/api/2024-10${path}`,
      method,
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, 'Content-Type': 'application/json' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({ raw: data }); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function pushStockToShopify(sku, nombre, newQty) {
  if (!SHOPIFY_TOKEN) return { skipped: true, reason: 'No token yet' };
  try {
    let inventoryItemId = null;
    if (sku) {
      const r = await shopifyRequest('GET', `/variants.json?sku=${encodeURIComponent(sku)}&limit=1`);
      inventoryItemId = r?.variants?.[0]?.inventory_item_id;
    }
    if (!inventoryItemId) {
      const r = await shopifyRequest('GET', `/products.json?title=${encodeURIComponent(nombre)}&limit=1`);
      inventoryItemId = r?.products?.[0]?.variants?.[0]?.inventory_item_id;
    }
    if (!inventoryItemId) return { skipped: true, reason: 'Not found in Shopify' };
    const result = await shopifyRequest('POST', '/inventory_levels/set.json', {
      location_id: parseInt(SHOPIFY_LOCATION),
      inventory_item_id: inventoryItemId,
      available: newQty
    });
    console.log(`🛒 Shopify actualizado: ${nombre} → ${newQty}`);
    return result;
  } catch(e) { return { error: e.message }; }
}

// ── Health check ───────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'ok',
  service: 'Aledans Home — Shopify Webhook Server',
  version: 'F4 — Bidireccional',
  shopify_sync: SHOPIFY_TOKEN ? 'bidireccional ✅' : '⚠️ falta SHOPIFY_ACCESS_TOKEN',
  timestamp: new Date().toISOString()
}));

// ── OAuth callback — obtiene el access token ───────────────
app.get('/auth/callback', async (req, res) => {
  const { code, shop } = req.query;
  if (!code || !shop) return res.status(400).send('Missing code or shop');
  try {
    const body = JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code });
    const tokenRes = await new Promise((resolve, reject) => {
      const opts = {
        hostname: shop,
        path: '/admin/oauth/access_token',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      };
      const r = https.request(opts, res2 => {
        let d = '';
        res2.on('data', c => d += c);
        res2.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d }); } });
      });
      r.on('error', reject);
      r.write(body);
      r.end();
    });

    if (tokenRes.access_token) {
      console.log('🎉 ACCESS TOKEN:', tokenRes.access_token);
      res.send(`<!DOCTYPE html><html><body style="font-family:monospace;padding:40px;background:#0d0d0f;color:#f0ede8;">
        <h2 style="color:#e8c07a">✅ Token obtenido</h2>
        <p>Copia este valor y pégalo en Render como <strong style="color:#e8c07a">SHOPIFY_ACCESS_TOKEN</strong>:</p>
        <div style="background:#1e1e21;padding:20px;border-radius:8px;border:2px solid #4ade80;
          word-break:break-all;color:#4ade80;font-size:15px;margin:16px 0;letter-spacing:0.5px;">
          ${tokenRes.access_token}
        </div>
        <p style="color:#9997a0;font-size:13px;">Una vez pegado en Render → Save Changes → el sistema queda 100% bidireccional.</p>
      </body></html>`);
    } else {
      res.status(500).send(`<pre style="background:#1e1e21;color:#f87171;padding:20px;">${JSON.stringify(tokenRes, null, 2)}</pre>`);
    }
  } catch(e) {
    res.status(500).send('Error: ' + e.message);
  }
});

// ── Shopify → Supabase: orden pagada ──────────────────────
app.post('/webhook/orders/paid', async (req, res) => {
  if (!verifyShopify(req.body, req.headers['x-shopify-hmac-sha256'])) return res.status(401).send('Unauthorized');
  let order;
  try { order = JSON.parse(req.body.toString()); } catch(e) { return res.status(400).send('Bad JSON'); }
  console.log(`📦 Orden pagada: #${order.order_number}`);
  const results = [];
  for (const item of (order.line_items || [])) {
    let q = sb.from('productos').select('id,nombre,sku,stock_online');
    if (item.sku) q = q.eq('sku', item.sku); else q = q.ilike('nombre', `%${item.title}%`);
    const { data: prods } = await q.limit(1);
    if (!prods?.length) { results.push({ title: item.title, status: 'not_found' }); continue; }
    const prod = prods[0];
    const newStock = Math.max(0, (prod.stock_online || 0) - item.quantity);
    await sb.from('productos').update({ stock_online: newStock }).eq('id', prod.id);
    await sb.from('movimientos').insert([{ prod_id: prod.id, tipo: 'venta', canal: 'online', qty: item.quantity, notas: `Shopify #${order.order_number}` }]);
    await sb.from('ventas').insert([{
      fecha: (order.created_at || new Date().toISOString()).split('T')[0],
      prod_id: prod.id, canal: 'online', qty: item.quantity,
      precio: parseFloat(item.price) || 0,
      notas: `Auto Shopify #${order.order_number}`
    }]);
    console.log(`✅ ${prod.nombre}: ${prod.stock_online} → ${newStock}`);
    results.push({ title: prod.nombre, prev: prod.stock_online, next: newStock, status: 'updated' });
  }
  res.json({ received: true, order: order.order_number, results });
});

// ── Shopify → Supabase: orden cancelada ───────────────────
app.post('/webhook/orders/cancelled', async (req, res) => {
  if (!verifyShopify(req.body, req.headers['x-shopify-hmac-sha256'])) return res.status(401).send('Unauthorized');
  let order;
  try { order = JSON.parse(req.body.toString()); } catch(e) { return res.status(400).send('Bad JSON'); }
  for (const item of (order.line_items || [])) {
    let q = sb.from('productos').select('id,nombre,stock_online');
    if (item.sku) q = q.eq('sku', item.sku); else q = q.ilike('nombre', `%${item.title}%`);
    const { data: prods } = await q.limit(1);
    if (!prods?.length) continue;
    const prod = prods[0];
    const newStock = (prod.stock_online || 0) + item.quantity;
    await sb.from('productos').update({ stock_online: newStock }).eq('id', prod.id);
    await sb.from('movimientos').insert([{ prod_id: prod.id, tipo: 'entrada', canal: 'online', qty: item.quantity, notas: `Devolución Shopify #${order.order_number}` }]);
    console.log(`↩️ Devuelto: ${prod.nombre} +${item.quantity}`);
  }
  res.json({ received: true, order: order.order_number });
});

// ── Supabase → Shopify: push de stock desde la app ────────
app.post('/sync/stock', async (req, res) => {
  const { prod_id, new_stock_online } = req.body;
  if (!prod_id) return res.status(400).json({ error: 'prod_id requerido' });
  if (new_stock_online === undefined || new_stock_online === null)
    return res.status(400).json({ error: 'new_stock_online requerido' });

  const { data: prods } = await sb.from('productos').select('id,nombre,sku,canal').eq('id', prod_id).limit(1);
  if (!prods?.length) return res.status(404).json({ error: 'No encontrado' });
  const prod = prods[0];

  if (prod.canal === 'bazar') return res.json({ synced: false, reason: 'Solo bazar — no va a Shopify' });

  // Usar el valor exacto que envía la app (ya descontado)
  const qty = parseInt(new_stock_online);
  const shopifyResult = await pushStockToShopify(prod.sku, prod.nombre, qty);
  console.log(`🔄 Sync→Shopify: ${prod.nombre} = ${qty}`);
  res.json({ synced: true, product: prod.nombre, new_qty: qty, shopify: shopifyResult });
});

// ── Shopify → Supabase: precio actualizado ────────────────
app.post('/webhook/products/update', async (req, res) => {
  if (!verifyShopify(req.body, req.headers['x-shopify-hmac-sha256'])) return res.status(401).send('Unauthorized');
  let product;
  try { product = JSON.parse(req.body.toString()); } catch(e) { return res.status(400).send('Bad JSON'); }
  const variant  = product.variants?.[0];
  const newPrice = parseFloat(variant?.price) || null;
  if (!newPrice) return res.json({ received: true, action: 'no_price' });
  let q = sb.from('productos').select('id,nombre');
  if (variant?.sku) q = q.eq('sku', variant.sku); else q = q.ilike('nombre', `%${product.title}%`);
  const { data: prods } = await q.limit(1);
  if (!prods?.length) return res.json({ received: true, action: 'not_found' });
  await sb.from('productos').update({ pshopify: newPrice }).eq('id', prods[0].id);
  console.log(`💲 Precio: ${prods[0].nombre} → $${newPrice}`);
  res.json({ received: true, action: 'price_updated', product: prods[0].nombre });
});

app.post('/webhook/*', (req, res) => res.json({ received: true, action: 'ignored' }));

app.listen(PORT, () => {
  console.log(`🚀 Aledans Webhook Server F4 — puerto ${PORT}`);
  console.log(`   Supabase:  ${SUPABASE_URL ? '✅' : '❌'}`);
  console.log(`   Shopify→Supabase: ✅ activo`);
  console.log(`   Supabase→Shopify: ${SHOPIFY_TOKEN ? '✅ bidireccional' : '⚠️  falta SHOPIFY_ACCESS_TOKEN'}`);
  console.log(`   OAuth callback: https://[tu-render-url]/auth/callback`);
});
