import { supabase } from "./supabaseClient.js";
import { dbRowToCustomer } from "./supabaseAuth.js";

/* ----------------------------------------------------------------------------
   GARANTIZA QUE EL CLIENTE TENGA UN RENGLÓN REAL EN `clientes`
   Se usa antes de registrar cualquier venta. Si el cliente ya tiene dbId, no
   hace nada. Si no (cuenta "Sin registrar" creada en esta misma sesión, o el
   navegador se recargó y el estado local se perdió), primero busca por
   teléfono — por si esa cuenta ya existe en la base aunque esta pestaña no lo
   sepa — y solo si de plano no existe la crea. El teléfono sigue siendo la
   llave única, igual que en registerCustomer.
---------------------------------------------------------------------------- */
export async function ensureClienteRow({ dbId, phone, name, origin }) {
  if (dbId != null) return { dbId };

  const cleanPhone = (phone || "").trim();
  if (!cleanPhone) return { error: "Falta el teléfono del cliente." };

  const { data: matchRows, error: matchError } = await supabase.rpc("find_provisional_by_phone", {
    phone_input: cleanPhone,
  });
  if (matchError) return { error: "No se pudo verificar el cliente en Supabase: " + matchError.message };
  const match = matchRows && matchRows[0];
  if (match) return { dbId: match.id, existing: true };

  const code =
    (name || "AMIGO").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6) +
    Math.floor(Math.random() * 900 + 100);

  const { data: inserted, error: insertError } = await supabase
    .from("clientes")
    .insert({
      name: name?.trim() || "Cliente sin registrar",
      phone: cleanPhone,
      status: "provisional",
      origin: origin || "whatsapp",
      referral_code: code,
      points: 0,
      total_purchases: 0,
      total_spent: 0,
    })
    .select("id")
    .single();
  if (insertError) return { error: "No se pudo crear el cliente en Supabase: " + insertError.message };
  return { dbId: inserted.id, existing: false };
}

/* ----------------------------------------------------------------------------
   GUARDA UN PEDIDO "PENDIENTE" EN CUANTO EL CLIENTE LO CONFIRMA EN LA PÁGINA
   Antes esto solo vivía en la memoria del navegador del cliente — el admin,
   en otro dispositivo, nunca lo veía en "Pedidos por confirmar". Se llama
   apenas se arma el pedido, antes de que un administrador toque nada.
---------------------------------------------------------------------------- */
export async function createPendingOrder({
  clienteDbId, items, subtotal, creditUsed, total, pointsEarned,
  paymentMethod, address, reference,
}) {
  const { data, error } = await supabase
    .from("pedidos")
    .insert({
      cliente_id: clienteDbId,
      status: "Pendiente",
      items: items.map(({ dbId, ...rest }) => rest),
      subtotal: subtotal ?? total,
      credit_used: creditUsed || 0,
      total,
      points_earned: pointsEarned,
      origin: "app",
      payment_method: paymentMethod || "",
      address: address || "",
      reference: reference || "",
    })
    .select("id")
    .single();
  if (error) return { error: "No se pudo guardar el pedido pendiente en Supabase: " + error.message };
  return { ok: true, pedidoId: data.id };
}

/* ----------------------------------------------------------------------------
   CAMBIA SOLO EL ESTADO DE UN PEDIDO YA GUARDADO (p. ej. "Cancelado").
   Si el pedido nunca llegó a guardarse en Supabase (pedidoId nulo — ver
   createPendingOrder), no hay nada que actualizar ahí y se responde ok igual,
   porque la pantalla ya refleja el cambio de todas formas.
---------------------------------------------------------------------------- */
export async function updateOrderStatus(pedidoId, status) {
  if (pedidoId == null) return { ok: true };
  const { error } = await supabase.from("pedidos").update({ status }).eq("id", pedidoId);
  if (error) return { error: "No se pudo actualizar el pedido en Supabase: " + error.message };
  return { ok: true };
}

/* ----------------------------------------------------------------------------
   TRAE TODOS LOS PEDIDOS (pendientes Y completados, de TODOS los clientes)
   CON SU CLIENTE, DIRECTO DE SUPABASE. Esto es lo que le da memoria real al
   panel de admin: antes, "Pedidos por confirmar", el historial y las
   estadísticas solo mostraban lo que había pasado en esa misma pestaña desde
   que se abrió — vacío en cualquier otro dispositivo o después de recargar.
---------------------------------------------------------------------------- */
function dbRowToOrder(row) {
  return {
    id: `db_${row.id}`,
    dbOrderId: row.id,
    customerId: `db_${row.cliente_id}`,
    date: (row.confirmed_at || row.created_at || "").slice(0, 10),
    subtotal: Number(row.subtotal ?? row.total ?? 0),
    creditUsed: Number(row.credit_used || 0),
    total: Number(row.total || 0),
    status: row.status,
    pointsEarned: row.points_earned || 0,
    items: row.items || [],
    origin: row.origin || "app",
    paymentMethod: row.payment_method || "",
    address: row.address || "",
    reference: row.reference || "",
  };
}

export async function loadOrdersWithCustomers() {
  const { data, error } = await supabase
    .from("pedidos")
    .select("*, clientes(*)")
    .order("created_at", { ascending: false });
  if (error) return { error: "No se pudieron cargar los pedidos de Supabase: " + error.message };

  const customers = [];
  const seenClientes = new Set();
  const orders = [];
  for (const row of data || []) {
    if (row.clientes && !seenClientes.has(row.cliente_id)) {
      seenClientes.add(row.cliente_id);
      customers.push(dbRowToCustomer(row.clientes, null));
    }
    orders.push(dbRowToOrder(row));
  }
  return { ok: true, customers, orders };
}

/* ----------------------------------------------------------------------------
   PUNTO ÚNICO DE ESCRITURA PARA UNA VENTA REAL
   Usado tanto por confirmOrder (pedido de la página) como por
   registerManualSale (venta de WhatsApp) — así nunca hay dos caminos que
   puedan desincronizarse. Orden de las escrituras: primero el pedido (si eso
   falla, no se otorgó nada y se puede reintentar tal cual); después, mejor
   esfuerzo, el stock, los totales del cliente y el movimiento de puntos —
   igual que setProductStock, si algo suelto falla solo se avisa en consola en
   vez de deshacer una venta que ya quedó guardada.

   `pedidoId`: si el pedido ya existía en Supabase como "Pendiente" (creado
   por createPendingOrder cuando el cliente lo confirmó en la página), se
   ACTUALIZA ese mismo renglón a "Completado" en vez de insertar uno nuevo —
   así nunca queda un pedido duplicado. Si no hay pedidoId (venta manual de
   WhatsApp, o un pedido de la página que por algo nunca se guardó como
   pendiente), se inserta uno nuevo directo como "Completado", igual que antes.
---------------------------------------------------------------------------- */
export async function recordSale({
  pedidoId, clienteDbId, items, subtotal, creditUsed, total, pointsEarned,
  origin, paymentMethod, address, reference,
  currentPoints, currentPurchases, currentSpent,
}) {
  const today = new Date().toISOString().slice(0, 10);
  const unitCount = items.reduce((s, i) => s + i.qty, 0);

  const payload = {
    cliente_id: clienteDbId,
    status: "Completado",
    items: items.map(({ dbId, ...rest }) => rest), // el detalle legible va en items; dbId solo se usa aquí abajo
    subtotal: subtotal ?? total,
    credit_used: creditUsed || 0,
    total,
    points_earned: pointsEarned,
    origin: origin || "app",
    payment_method: paymentMethod || "",
    address: address || "",
    reference: reference || "",
    confirmed_at: new Date().toISOString(),
  };

  const { data: pedido, error: pedidoError } = pedidoId != null
    ? await supabase.from("pedidos").update(payload).eq("id", pedidoId).select("id").single()
    : await supabase.from("pedidos").insert(payload).select("id").single();
  if (pedidoError) return { error: "No se pudo guardar el pedido en Supabase: " + pedidoError.message };

  for (const item of items) {
    if (item.dbId == null) continue;
    const { data: saborRow, error: readError } = await supabase
      .from("sabores").select("stock").eq("id", item.dbId).maybeSingle();
    if (readError || !saborRow) {
      console.warn("recordSale: no se pudo leer stock del sabor", item.dbId, readError);
      continue;
    }
    const nextStock = Math.max(0, (saborRow.stock || 0) - item.qty);
    const { error: stockError } = await supabase.from("sabores").update({ stock: nextStock }).eq("id", item.dbId);
    if (stockError) console.warn("recordSale: no se pudo descontar stock del sabor", item.dbId, stockError);
  }

  const { data: clienteRow, error: clienteError } = await supabase
    .from("clientes")
    .update({
      points: (currentPoints || 0) + pointsEarned,
      total_purchases: (currentPurchases || 0) + 1,
      total_spent: (currentSpent || 0) + total,
      last_purchase_at: today,
    })
    .eq("id", clienteDbId)
    .select("points, total_purchases, total_spent, last_purchase_at")
    .single();
  if (clienteError) console.warn("recordSale: pedido guardado pero no se pudo actualizar el cliente:", clienteError);

  const { error: transError } = await supabase.from("transacciones").insert({
    cliente_id: clienteDbId,
    type: "purchase",
    amount: pointsEarned,
    description: origin === "whatsapp"
      ? `Venta manual (WhatsApp) — ${unitCount} producto${unitCount > 1 ? "s" : ""}`
      : `Pedido confirmado — ${unitCount} producto${unitCount > 1 ? "s" : ""}`,
    related_order_id: pedido.id,
    created_at: today,
  });
  if (transError) console.warn("recordSale: pedido guardado pero no se pudo registrar el movimiento de puntos:", transError);

  return { ok: true, pedidoId: pedido.id, cliente: clienteRow || null };
}
