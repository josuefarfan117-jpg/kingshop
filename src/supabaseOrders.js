import { supabase } from "./supabaseClient.js";

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
   PUNTO ÚNICO DE ESCRITURA PARA UNA VENTA REAL
   Usado tanto por confirmOrder (pedido de la página) como por
   registerManualSale (venta de WhatsApp) — así nunca hay dos caminos que
   puedan desincronizarse. Orden de las escrituras: primero el pedido (si eso
   falla, no se otorgó nada y se puede reintentar tal cual); después, mejor
   esfuerzo, el stock, los totales del cliente y el movimiento de puntos —
   igual que setProductStock, si algo suelto falla solo se avisa en consola en
   vez de deshacer una venta que ya quedó guardada.
---------------------------------------------------------------------------- */
export async function recordSale({
  clienteDbId, items, subtotal, creditUsed, total, pointsEarned,
  origin, paymentMethod, address, reference,
  currentPoints, currentPurchases, currentSpent,
}) {
  const today = new Date().toISOString().slice(0, 10);
  const unitCount = items.reduce((s, i) => s + i.qty, 0);

  const { data: pedido, error: pedidoError } = await supabase
    .from("pedidos")
    .insert({
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
    })
    .select("id")
    .single();
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
