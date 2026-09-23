import { supabase } from "./supabaseClient.js";

/* ----------------------------------------------------------------------------
   PUNTOS, CANJES Y CRÉDITO: lo que antes vivía solo en la memoria del navegador.
   Todo pasa por funciones SQL (ver fix-puntos-canjes-referidos.sql) para que
   descontar puntos, crear el canje y registrar el movimiento sea UNA sola
   operación: o se guarda todo, o no se guarda nada.
---------------------------------------------------------------------------- */

const errText = (error) => `${error.message}${error.code ? ` (código ${error.code})` : ""}`;

export function dbRowToRedemption(row) {
  return {
    id: `db_${row.id}`,
    dbId: row.id,
    rewardId: row.reward_id,
    pointsUsed: row.points_used,
    code: row.code,
    status: row.status,
    creditValue: row.credit_value == null ? null : Number(row.credit_value),
    creditRemaining: row.credit_remaining == null ? null : Number(row.credit_remaining),
    usedOn: Array.isArray(row.used_on) ? row.used_on : [],
    createdAt: (row.created_at || "").slice(0, 10),
    fulfilledAt: row.fulfilled_at ? row.fulfilled_at.slice(0, 10) : null,
  };
}

export function dbRowToTransaction(row) {
  return {
    id: `db_${row.id}`,
    type: row.type,
    amount: row.amount,
    description: row.description || "",
    relatedOrderId: row.related_order_id != null ? `db_${row.related_order_id}` : null,
    createdAt: (row.created_at || "").slice(0, 10),
  };
}

export async function loadMyRedemptions() {
  try {
    const { data, error } = await supabase.rpc("get_my_redemptions");
    if (error) return { error: "No se pudieron cargar tus recompensas: " + errText(error) };
    return { ok: true, redemptions: (data || []).map(dbRowToRedemption) };
  } catch (e) { return { error: "Error inesperado al cargar recompensas: " + (e?.message || String(e)) }; }
}

export async function loadMyTransactions() {
  try {
    const { data, error } = await supabase.rpc("get_my_transactions");
    if (error) return { error: "No se pudo cargar tu historial de puntos: " + errText(error) };
    return { ok: true, transactions: (data || []).map(dbRowToTransaction) };
  } catch (e) { return { error: "Error inesperado al cargar movimientos: " + (e?.message || String(e)) }; }
}

/** Canjea una recompensa: descuenta puntos, crea el canje y el movimiento. */
export async function redeemReward({ rewardId, pointsCost, creditValue }) {
  try {
    const { data, error } = await supabase.rpc("redeem_reward", {
      p_reward_id: String(rewardId),
      p_points_cost: pointsCost,
      p_credit_value: typeof creditValue === "number" ? creditValue : null,
    });
    if (error) return { error: error.message };
    return { ok: true, redemption: dbRowToRedemption(data) };
  } catch (e) { return { error: "Error inesperado al canjear: " + (e?.message || String(e)) }; }
}

/** Admin: al cancelar un pedido, devuelve el crédito que había apartado. */
export async function releaseOrderCredit(pedidoId) {
  if (pedidoId == null) return { ok: true };
  try {
    const { error } = await supabase.rpc("release_order_credit", { p_pedido_id: pedidoId });
    if (error) return { error: "No se pudo devolver el crédito del pedido: " + errText(error) };
    return { ok: true };
  } catch (e) { return { error: "Error inesperado al devolver crédito: " + (e?.message || String(e)) }; }
}

/** Admin: paga el premio por referido si esta fue la primera compra del invitado. */
export async function awardReferralIfFirstPurchase(clienteDbId, referrerPoints, referredPoints) {
  try {
    const { data, error } = await supabase.rpc("award_referral_if_first_purchase", {
      p_cliente_id: clienteDbId, p_referrer_points: referrerPoints, p_referred_points: referredPoints,
    });
    if (error) return { error: "No se pudo acreditar el referido: " + errText(error) };
    return { ok: true, awarded: !!data?.awarded, referrerId: data?.referrer_id ?? null, referrerName: data?.referrer_name ?? null };
  } catch (e) { return { error: "Error inesperado al acreditar referido: " + (e?.message || String(e)) }; }
}

/** Admin: recompensas físicas (gift cards) canjeadas y todavía sin entregar. */
export async function loadPendingRedemptions() {
  try {
    const { data, error } = await supabase
      .from("canjes").select("*").eq("status", "PENDIENTE DE ENTREGA").order("created_at", { ascending: true });
    if (error) return { error: "No se pudieron cargar las recompensas por entregar: " + errText(error) };
    const ids = [...new Set((data || []).map((r) => r.cliente_id))];
    let byId = {};
    if (ids.length > 0) {
      const { data: cs } = await supabase.from("clientes").select("id, name, phone, email").in("id", ids);
      byId = Object.fromEntries((cs || []).map((c) => [c.id, c]));
    }
    return {
      ok: true,
      items: (data || []).map((r) => ({
        ...dbRowToRedemption(r),
        customerName: byId[r.cliente_id]?.name || "Cliente",
        customerPhone: byId[r.cliente_id]?.phone || "",
        customerEmail: byId[r.cliente_id]?.email || "",
      })),
    };
  } catch (e) { return { error: "Error inesperado: " + (e?.message || String(e)) }; }
}

export async function markRedemptionFulfilled(canjeDbId) {
  try {
    const { data, error } = await supabase.rpc("mark_redemption_fulfilled", { p_id: canjeDbId });
    if (error) return { error: "No se pudo marcar como entregada: " + errText(error) };
    if (!data) return { error: "Esta recompensa ya no estaba pendiente. Toca Actualizar." };
    return { ok: true };
  } catch (e) { return { error: "Error inesperado: " + (e?.message || String(e)) }; }
}
