const express = require('express');
const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ── Config desde variables de entorno ──────────────────────
const SHOPIFY_SECRET  = process.env.SHOPIFY_WEBHOOK_SECRET;  // lo pegas en Render
const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_KEY;    // service_role key
const PORT            = process.env.PORT || 3000;

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Necesitamos el body RAW para verificar la firma de Shopify ──
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Health check (Render lo usa para saber que el server vive) ──
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Aledans Home — Shopify Webhook Server',
    timestamp: new Date().toISOString()
  });
});

// ── Verificar firma HMAC de Shopify ───────────────────────
function verifyShopifyWebhook(rawBody, hmacHeader) {
  if (!SHOPIFY_SECRET) return true; // skip en desarrollo
  const digest = crypto
    .createHmac('sha256', SHOPIFY_SECRET)
    .update(rawBody)
    .digest('base64');
  return digest === hmacHeader;
}

// ══════════════════════════════════════════════════════════
// WEBHOOK: orders/paid  — cuando se paga una orden en Shopify
// Descuenta stock online en Supabase automáticamente
// ══════════════════════════════════════════════════════════
app.post('/webhook/orders/paid', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verifyShopifyWebhook(req.body, hmac)) {
    console.warn('⚠️  Firma inválida — request rechazado');
    return res.status(401).send('Unauthorized');
  }

  let order;
  try {
    order = JSON.parse(req.body.toString());
  } catch (e) {
    return res.status(400).send('Bad JSON');
  }

  console.log(`📦 Orden recibida: #${order.order_number} — ${order.line_items?.length} productos`);

  const results = [];

  for (const item of (order.line_items || [])) {
    const sku   = item.sku;
    const qty   = item.quantity;
    const title = item.title;

    if (!sku && !title) continue;

    // Buscar producto en Supabase por SKU o nombre
    let query = sb.from('productos').select('id, nombre, sku, stock_online');
    if (sku) {
      query = query.eq('sku', sku);
    } else {
      query = query.ilike('nombre', `%${title}%`);
    }

    const { data: prods, error: findErr } = await query.limit(1);

    if (findErr || !prods?.length) {
      console.warn(`⚠️  Producto no encontrado: SKU="${sku}" Nombre="${title}"`);
      results.push({ sku, title, status: 'not_found' });
      continue;
    }

    const prod     = prods[0];
    const newStock = Math.max(0, (prod.stock_online || 0) - qty);

    const { error: updateErr } = await sb
      .from('productos')
      .update({ stock_online: newStock })
      .eq('id', prod.id);

    if (updateErr) {
      console.error(`❌ Error actualizando ${prod.nombre}:`, updateErr.message);
      results.push({ id: prod.id, title, status: 'error', error: updateErr.message });
      continue;
    }

    // Registrar movimiento en auditoría
    await sb.from('movimientos').insert([{
      prod_id: prod.id,
      tipo:    'venta',
      canal:   'online',
      qty:     qty,
      notas:   `Orden Shopify #${order.order_number}`
    }]);

    // Registrar la venta en tabla ventas
    await sb.from('ventas').insert([{
      fecha:   order.created_at ? order.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
      prod_id: prod.id,
      canal:   'online',
      qty:     qty,
      precio:  parseFloat(item.price) || 0,
      notas:   `Auto — Shopify #${order.order_number}`
    }]);

    console.log(`✅ ${prod.nombre}: stock_online ${prod.stock_online} → ${newStock}`);
    results.push({ id: prod.id, title: prod.nombre, prev: prod.stock_online, next: newStock, status: 'updated' });
  }

  res.json({ received: true, order: order.order_number, results });
});

// ══════════════════════════════════════════════════════════
// WEBHOOK: orders/cancelled — si cancela una orden, devuelve stock
// ══════════════════════════════════════════════════════════
app.post('/webhook/orders/cancelled', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verifyShopifyWebhook(req.body, hmac)) return res.status(401).send('Unauthorized');

  let order;
  try { order = JSON.parse(req.body.toString()); }
  catch (e) { return res.status(400).send('Bad JSON'); }

  console.log(`🔄 Orden cancelada: #${order.order_number}`);

  for (const item of (order.line_items || [])) {
    const sku = item.sku;
    const qty = item.quantity;

    let query = sb.from('productos').select('id, nombre, stock_online');
    if (sku) query = query.eq('sku', sku);
    else query = query.ilike('nombre', `%${item.title}%`);

    const { data: prods } = await query.limit(1);
    if (!prods?.length) continue;

    const prod = prods[0];
    const newStock = (prod.stock_online || 0) + qty;

    await sb.from('productos').update({ stock_online: newStock }).eq('id', prod.id);
    await sb.from('movimientos').insert([{
      prod_id: prod.id, tipo: 'entrada', canal: 'online',
      qty, notas: `Devolución — Orden cancelada #${order.order_number}`
    }]);

    console.log(`↩️  Stock devuelto: ${prod.nombre} +${qty} → ${newStock}`);
  }

  res.json({ received: true, order: order.order_number });
});

// ══════════════════════════════════════════════════════════
// WEBHOOK: products/update — si editas un producto en Shopify,
// actualiza precio en Supabase
// ══════════════════════════════════════════════════════════
app.post('/webhook/products/update', async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!verifyShopifyWebhook(req.body, hmac)) return res.status(401).send('Unauthorized');

  let product;
  try { product = JSON.parse(req.body.toString()); }
  catch (e) { return res.status(400).send('Bad JSON'); }

  const variant  = product.variants?.[0];
  const sku      = variant?.sku;
  const newPrice = parseFloat(variant?.price) || null;
  const title    = product.title;

  if (!newPrice) return res.json({ received: true, action: 'no_price_change' });

  let query = sb.from('productos').select('id, nombre, pshopify');
  if (sku) query = query.eq('sku', sku);
  else query = query.ilike('nombre', `%${title}%`);

  const { data: prods } = await query.limit(1);
  if (!prods?.length) return res.json({ received: true, action: 'product_not_found' });

  await sb.from('productos').update({ pshopify: newPrice }).eq('id', prods[0].id);
  console.log(`💲 Precio Shopify actualizado: ${prods[0].nombre} → $${newPrice}`);

  res.json({ received: true, action: 'price_updated', product: prods[0].nombre, price: newPrice });
});

// ── Catch-all para otros webhooks (los ignora gracefully) ──
app.post('/webhook/*', (req, res) => {
  console.log(`ℹ️  Webhook ignorado: ${req.path}`);
  res.json({ received: true, action: 'ignored' });
});

app.listen(PORT, () => {
  console.log(`🚀 Aledans Webhook Server corriendo en puerto ${PORT}`);
  console.log(`   Supabase: ${SUPABASE_URL ? '✅ configurado' : '❌ falta SUPABASE_URL'}`);
  console.log(`   Shopify secret: ${SHOPIFY_SECRET ? '✅ configurado' : '⚠️  no configurado (modo dev)'}`);
});
