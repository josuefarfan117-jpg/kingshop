import { supabase } from "./supabaseClient.js";
import { makeCustomer } from "./CustomerHub.jsx";

/* ----------------------------------------------------------------------------
   Convierte un renglón real de la tabla `clientes` al mismo formato que ya
   usaba toda la app (el que arma `makeCustomer`). Así el resto del código
   (puntos, referidos, pantallas) no tiene que cambiar cómo lee al cliente,
   nada más cambia de dónde viene el dato.
---------------------------------------------------------------------------- */
export function dbRowToCustomer(row, email) {
  return {
    ...makeCustomer({
      id: `db_${row.id}`,
      name: row.name,
      phone: row.phone,
      email: row.email || email || null,
      pointsBalance: row.points || 0,
      totalPurchases: row.total_purchases || 0,
      totalSpent: Number(row.total_spent || 0),
      lastPurchase: row.last_purchase_at || null,
      createdAt: (row.created_at || "").slice(0, 10),
      referralCode: row.referral_code,
      referredBy: row.referred_by || null,
      referralRewarded: row.referral_rewarded || false,
      membershipLevel: row.membership_level || "Bienvenida",
      status: row.status || "active",
      origin: row.origin || "app",
    }),
    dbId: row.id,
    userId: row.user_id,
    storeCredit: row.store_credit || 0,
  };
}

function generateReferralCode(name) {
  return (
    (name || "AMIGO").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 6) +
    Math.floor(Math.random() * 900 + 100)
  );
}

/**
 * Busca quién es dueño de un código de referido (?ref=CODIGO), sin exponer
 * el resto de la tabla `clientes` a un visitante anónimo.
 */
export async function findReferrerByCode(code) {
  if (!code) return null;
  const { data, error } = await supabase.rpc("find_referrer_by_code", { code_input: code });
  if (error || !data || !data.length) return null;
  const row = data[0];
  return { id: `db_${row.id}`, dbId: row.id, name: row.name, code };
}

/**
 * Crea la cuenta real (Supabase Auth) y su renglón en `clientes`. Si ya
 * existía una cuenta PROVISIONAL con ese teléfono (de una venta manual), la
 * "reclama" y activa en vez de crear un cliente nuevo — así conserva sus
 * puntos e historial, tal como se diseñó.
 */
export async function registerCustomer({ name, phone, email, password, referrerCode }) {
  // 1) ¿Ya existe una cuenta (activa o provisional) con este teléfono?
  const { data: matchRows, error: matchError } = await supabase.rpc("find_provisional_by_phone", {
    phone_input: phone,
  });
  if (matchError) return { error: "No se pudo verificar el teléfono. Intenta de nuevo." };
  const match = matchRows && matchRows[0];

  if (match && match.status === "active") {
    return { error: "Ya existe una cuenta con este teléfono. Inicia sesión en vez de crear una nueva." };
  }

  // 2) Crear la cuenta real de acceso (correo + contraseña).
  const { data: authData, error: authError } = await supabase.auth.signUp({ email, password });
  if (authError) return { error: traduceAuthError(authError) };

  const needsEmailConfirmation = !authData.session;
  const userId = authData.user?.id;
  if (!userId) return { error: "No se pudo crear la cuenta. Intenta de nuevo." };

  const code = generateReferralCode(name);

  if (match && match.status === "provisional") {
    // Reclamar la cuenta provisional: se actualiza en vez de crear una nueva,
    // así conserva los puntos y compras que ya tenía.
    const { data: updated, error: updateError } = await supabase
      .from("clientes")
      .update({ user_id: userId, name, email, status: "active", origin: match.origin || "app" })
      .eq("id", match.id)
      .select()
      .single();
    if (updateError) return { error: "Tu cuenta de acceso se creó, pero no se pudo vincular con tus compras anteriores. Contáctanos." };
    return { customer: dbRowToCustomer(updated, email), needsEmailConfirmation };
  }

  // 3) Cliente totalmente nuevo.
  const { data: inserted, error: insertError } = await supabase
    .from("clientes")
    .insert({
      user_id: userId,
      name,
      phone,
      email,
      status: "active",
      origin: "app",
      referral_code: code,
      referred_by: referrerCode || null,
    })
    .select()
    .single();
  if (insertError) return { error: "Tu cuenta de acceso se creó, pero no se pudo guardar tu perfil. Contáctanos." };

  return { customer: dbRowToCustomer(inserted, email), needsEmailConfirmation };
}

/** Inicia sesión real contra Supabase Auth y trae el perfil de `clientes`. */
export async function signInCustomer({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: traduceAuthError(error) };

  const { data: row, error: rowError } = await supabase
    .from("clientes")
    .select("*")
    .eq("user_id", data.user.id)
    .maybeSingle();
  if (rowError || !row) {
    return { error: "Tu cuenta existe pero no encontramos tu perfil de cliente. Contáctanos." };
  }
  return { customer: dbRowToCustomer(row, email) };
}

export async function signOutCustomer() {
  await supabase.auth.signOut();
}

/**
 * Inicia sesión real de administrador. A diferencia de verifyAdminCode (que
 * solo comparaba un código contra un hash), esto crea una sesión de verdad
 * en Supabase Auth — la misma que después usan las políticas de RLS en
 * `modelos`, `sabores`, `clientes`, `pedidos`, etc. para saber que quien está
 * escribiendo de verdad es un administrador, y no cualquiera con la llave
 * anon del navegador. Si el correo/contraseña son válidos pero esa cuenta NO
 * está en la tabla `admins`, se cierra la sesión inmediatamente — entrar con
 * una cuenta de cliente normal no debe abrir el panel.
 */
export async function signInAdmin(email, password) {
  const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
  if (authError) return { error: "Correo o contraseña incorrectos." };

  const { data: isAdmin, error: rpcError } = await supabase.rpc("is_current_user_admin");
  if (rpcError || !isAdmin) {
    await supabase.auth.signOut();
    return { error: "Esta cuenta no tiene permisos de administrador." };
  }
  return { ok: true };
}

export async function signOutAdmin() {
  await supabase.auth.signOut();
}

/**
 * Verifica el código de acceso del panel de administrador contra Supabase.
 * El código real (hasheado) vive en la tabla `admin_config`, protegida con
 * RLS: el navegador nunca puede leer el hash, solo puede pedirle a la
 * función `verify_admin_code` que compare y le regrese true/false. Así el
 * código deja de estar escrito en el archivo que cualquiera podría abrir
 * con las herramientas de desarrollador.
 *
 * @deprecated Reemplazado por signInAdmin (correo + contraseña reales). Se
 * deja aquí solo por si algún flujo viejo lo sigue importando; no se usa en
 * AdminGateView.
 */
export async function verifyAdminCode(code) {
  const { data, error } = await supabase.rpc("verify_admin_code", { code_input: code });
  if (error) return false;
  return data === true;
}

/** Al abrir la app: si ya había una sesión iniciada, la recupera sola. */
export async function getActiveSessionCustomer() {
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session;
  if (!session) return null;

  const { data: row, error } = await supabase
    .from("clientes")
    .select("*")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (error || !row) return null;
  return dbRowToCustomer(row, session.user.email);
}

function traduceAuthError(error) {
  const msg = (error?.message || "").toLowerCase();
  if (msg.includes("already registered") || msg.includes("already exists")) {
    return "Ya existe una cuenta con ese correo. Inicia sesión en vez de crear una nueva.";
  }
  if (msg.includes("password")) {
    return "La contraseña no cumple los requisitos mínimos (revisa la longitud).";
  }
  if (msg.includes("invalid login credentials")) {
    return "Correo o contraseña incorrectos.";
  }
  if (msg.includes("email not confirmed")) {
    return "Todavía no confirmas tu correo. Revisa tu bandeja de entrada.";
  }
  return error?.message || "Ocurrió un error. Intenta de nuevo.";
}
