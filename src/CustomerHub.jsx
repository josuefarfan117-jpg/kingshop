import React, { useState, useMemo, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import {
  Home, ShoppingBag, Gift, Wallet, User, MessageCircle, Users, ChevronRight, ChevronLeft,
  Copy, Check, X, ArrowLeft, Menu, LogOut, TrendingUp, TrendingDown, Star,
  Clock, Package, Sparkles, ChevronDown, ChevronUp, Plus, Minus, Lock, Eye, EyeOff,
  Banknote, Landmark, CreditCard, MapPin, Tag,
} from "lucide-react";
import {
  registerCustomer, signInCustomer, signOutCustomer,
  getActiveSessionCustomer, findReferrerByCode, signInAdmin, signOutAdmin, hasActiveAdminSession,
} from "./supabaseAuth.js";
import { supabase } from "./supabaseClient.js";
import {
  loadMyRedemptions, loadMyTransactions, redeemReward, releaseOrderCredit,
  awardReferralIfFirstPurchase as awardReferralInDb, loadPendingRedemptions, markRedemptionFulfilled, loadMyReferrals,
} from "./supabaseRewards.js";
import { ensureClienteRow, recordSale, createPendingOrder, updateOrderStatus, loadOrdersWithCustomers, loadMyOrders, updatePendingOrderItems } from "./supabaseOrders.js";

/* ----------------------------------------------------------------------------
   CAMPANITA DE PEDIDOS NUEVOS (panel admin)
   Sonido generado con Web Audio (sin archivos). Los navegadores solo dejan
   sonar audio después de que la persona tocó algo en la página, por eso el
   contexto se "desbloquea" con el primer toque en el panel (ver unlockBell).
---------------------------------------------------------------------------- */
let _bellCtx = null;
function unlockBell() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!_bellCtx) _bellCtx = new AC();
    if (_bellCtx.state === "suspended") _bellCtx.resume();
  } catch (e) { /* sin audio, no pasa nada */ }
}
function playBell(times = 3) {
  try {
    unlockBell();
    if (!_bellCtx || _bellCtx.state !== "running") return false;
    const ctx = _bellCtx;
    for (let i = 0; i < times; i++) {
      const t0 = ctx.currentTime + i * 0.55;
      [880, 1320].forEach((freq, k) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(k === 0 ? 0.35 : 0.18, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t0); osc.stop(t0 + 0.52);
      });
    }
    return true;
  } catch (e) { return false; }
}
const ADMIN_POLL_MS = 20000; // cada cuánto revisa pedidos nuevos el panel


/* ============================================================================
   MODELOS DE DATOS (forma prevista para una futura API/backend)
   User, Customer, Product, Order, OrderItem, PointTransaction, Reward,
   Redemption, Referral, Promotion, Membership.
   Todo lo de abajo son DATOS DEMO — la UI nunca asume que esta es la
   economía de puntos definitiva. En producción esto vendría de servicios
   (ver /services al final de este archivo, comentado) respaldados por
   Supabase/Firebase/Postgres + Auth + CRM.
============================================================================ */

const POINTS_PER_PURCHASE_RATE = 0.2; // DEMO: 1 MXN gastado ≈ 0.2 puntos. Configurable.

// Número real de WhatsApp del negocio — el botón "Hacer pedido" abre el chat aquí.
const WHATSAPP_NUMBER = "523320465574";
function waLink(text) {
  return `https://wa.me/${WHATSAPP_NUMBER}${text ? "?text=" + encodeURIComponent(text) : ""}`;
}

// Métodos de pago disponibles al finalizar el pedido — se preguntan antes de enviar por WhatsApp.
const PAYMENT_METHODS = [
  { id: "efectivo", label: "Efectivo", description: "Pagas al recibir tu pedido.", icon: "cash" },
  { id: "transferencia", label: "Transferencia", description: "Te compartimos los datos bancarios por WhatsApp.", icon: "transfer" },
  { id: "terminal", label: "Terminal (tarjeta)", description: "Pago con tarjeta al momento de la entrega.", icon: "card" },
];

// Recompensas: catálogo de puntos — separado del catálogo de productos.
// `creditValue` marca las recompensas que son SALDO para gastar en la tienda:
// al canjearse no se entregan en mano, se guardan en la cuenta del cliente y
// se descuentan del total de su siguiente pedido (ver "crédito de tienda").
// AirPods y bocina quedan fuera por ahora — para reactivarlos basta volver a
// agregarlos a esta lista, nada más depende de ellos.
// Gift cards: Amazon México confirmado — su tarjeta de regalo se compra en el
// monto exacto que se necesite (no viene en denominaciones fijas), así que
// $500 y $1,000 son válidos. Mercado Libre NO tiene esta opción: su única
// oferta de "tarjetas de regalo" es para plataformas de juegos (Roblox, Xbox,
// etc.) bajo su categoría "Digital Goods", no una tarjeta genérica de saldo
// para comprar cualquier cosa en el marketplace. Por eso solo se ofrece Amazon.
export let REWARDS = [
  { id: "r5", name: "Crédito The King Shop $500", description: "Saldo de $500 que se descuenta solo al hacer tu siguiente pedido en la tienda.", pointsCost: 2500, category: "Crédito interno", active: true, stock: null, image: "credit", creditValue: 500 },
  { id: "r1", name: "Gift card Amazon México $500", description: "Código de regalo de Amazon México por $500, se envía a tu correo o WhatsApp.", pointsCost: 3000, category: "Gift card", active: true, stock: null, image: "cash", giftBrand: "Amazon México" },
  { id: "r2", name: "Gift card Amazon México $1,000", description: "Código de regalo de Amazon México por $1,000, se envía a tu correo o WhatsApp.", pointsCost: 5500, category: "Gift card", active: true, stock: null, image: "cash", giftBrand: "Amazon México" },
];

/* ----------------------------------------------------------------------------
   PROGRAMA DE REFERIDOS
   El referidor gana puntos cuando su invitado hace su PRIMERA compra
   confirmada (no al registrarse: así nadie gana puntos creando cuentas vacías).
   El invitado recibe un bono de bienvenida en esa misma compra.
---------------------------------------------------------------------------- */
const REFERRAL_POINTS_REFERRER = 200;
const REFERRAL_POINTS_REFERRED = 100;

/* ----------------------------------------------------------------------------
   TOPE DEL CRÉDITO DE TIENDA
   El crédito nunca cubre más del 30% del pedido — así, incluso en la promo con
   menos margen, nunca se pierde dinero al aplicarlo: siempre queda cubierta
   la inversión. Lo que no se usa por el tope se queda en la cuenta para el
   siguiente pedido, nunca se pierde.
---------------------------------------------------------------------------- */
/* ----------------------------------------------------------------------------
   ACCESO DE ADMINISTRADOR
   No es una cuenta de cliente ni aparece en el menú. Se entra por una
   combinación oculta (5 toques rápidos al logo, o abrir la página con
   ?staff=1 en la URL) y pide un código antes de mostrar cualquier dato.
   El código YA NO vive en este archivo: se verifica contra Supabase con
   verifyAdminCode() (ver supabaseAuth.js), comparando contra un hash
   guardado en la tabla admin_config, protegida por RLS — nadie puede leer
   ese hash desde el navegador, solo la función de la base puede compararlo.
   Para cambiar el código, se actualiza directo en Supabase (ver README).
---------------------------------------------------------------------------- */

// Logo real: pega aquí la URL pública de tu logo (Storage → tu foto → "Get
// URL", igual que hiciste con las fotos de producto). Mientras esté vacío,
// se muestra el cuadrito "TKS" como respaldo.
const LOGO_URL = "https://pavenuquzhveityppyqc.supabase.co/storage/v1/object/public/brand/lopgo.PNG";

function LogoMark({ size = 52, fontSize = 20, style }) {
  return (
    <div className="ch-logo-mark" style={{ width: size, height: size, fontSize, ...style }}>
      {LOGO_URL ? (
        <img
          src={LOGO_URL}
          alt="The King Shop"
          style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: "inherit" }}
        />
      ) : (
        "TKS"
      )}
    </div>
  );
}
const ADMIN_SESSION_KEY = "tks_admin_ok";

const CREDIT_MAX_PERCENT = 0.30;
function maxCreditForOrder(subtotal) {
  return Math.floor(subtotal * CREDIT_MAX_PERCENT);
}
function creditAppliedFor(subtotal, available) {
  return Math.max(0, Math.min(available, maxCreditForOrder(subtotal)));
}

// Dominio real de la página. De aquí cuelga el enlace personal de cada
// cliente. Se toma del navegador (window.location.origin) para que el
// enlace siempre apunte a donde de verdad está corriendo la página — sirve
// igual en localhost mientras pruebas, que en el dominio real una vez
// publicada — sin tener que acordarte de cambiar nada aquí. FALLBACK_SITE_URL
// solo se usa si por algún motivo no hay `window` (no debería pasar en el
// navegador); ajústalo aquí una sola vez si tu dominio cambia.
const FALLBACK_SITE_URL = "https://thekingshop.com.mx";
const SITE_URL = (typeof window !== "undefined" && window.location?.origin) || FALLBACK_SITE_URL;
function referralLink(code) {
  return `${SITE_URL}/?ref=${code}`;
}

/* Lee el código de referido de la URL: acepta /?ref=CODIGO y /r/CODIGO. */
function readReferralFromUrl() {
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get("ref") || url.searchParams.get("r");
    if (q) return q.trim().toUpperCase();
    const m = url.pathname.match(/\/r\/([A-Za-z0-9]+)/);
    if (m) return m[1].toUpperCase();
  } catch (e) { /* entorno sin window/URL */ }
  return null;
}
// El código sobrevive a que la persona navegue, cierre y vuelva: se guarda
// hasta que se registra. Si el navegador bloquea el almacenamiento (modo
// incógnito estricto), el flujo sigue funcionando dentro de la misma sesión.
const REF_STORAGE_KEY = "tks_ref";
function loadStoredReferral() {
  try { return window.localStorage.getItem(REF_STORAGE_KEY); } catch (e) { return null; }
}
function storeReferral(code) {
  try { window.localStorage.setItem(REF_STORAGE_KEY, code); } catch (e) { /* ignorar */ }
}
function clearStoredReferral() {
  try { window.localStorage.removeItem(REF_STORAGE_KEY); } catch (e) { /* ignorar */ }
}

// Catálogo de productos — The King Shop, múltiples modelos.
// Cada modelo tiene su propio precio 1x/2x: la promo NO se mezcla entre modelos,
// solo entre sabores del mismo modelo (así como se ve en cada tarjeta/flyer).
export let MODELS = [
  {
    id: "m_iplaybigmax",
    name: "iPlay Big Max",
    subtitle: "5000 Puffs",
    icon: "👑",
    priceSingle: 350,
    priceDuo: 500,
    specs: [{ label: "Puffs", value: "Hasta 5000" }],
    flavors: [
      { name: "Black Mint", stock: 13 },
      { name: "Blueberry Cherry", stock: 7 },
      { name: "Blueberry Ice", stock: 23 },
      { name: "Blueberry Watermelon", stock: 21 },
      { name: "Cherry Mint", stock: 20 },
      { name: "Cool Mint", stock: 14 },
      { name: "Double Mint", stock: 12 },
      { name: "Tulum Mint", stock: 40 },
    ],
  },
  {
    id: "m_iplayxbox",
    name: "iPlay X Box",
    subtitle: "4000 Puffs",
    icon: "📦",
    priceSingle: 350,
    priceDuo: 500,
    specs: [{ label: "Puffs", value: "Hasta 4000" }],
    flavors: [
      { name: "Blueberry Cherry", stock: 11 },
      { name: "Blueberry Mint", stock: 43 },
      { name: "Blueberry Storm", stock: 33 },
      { name: "Coco Strawberry", stock: 8 },
      { name: "Cool Mint", stock: 7 },
      { name: "Grape Strawberry", stock: 11 },
      { name: "Mr. Peach Mint", stock: 19 },
      { name: "Perla Negra", stock: 20 },
      { name: "Pink Lemonade", stock: 38 },
      { name: "Strawberry Watermelon", stock: 44 },
      { name: "Tulum Mint", stock: 7 },
      { name: "Watermelon Crush", stock: 41 },
    ],
  },
  {
    id: "m_geekbarpulse15k",
    name: "Geek Bar Pulse",
    subtitle: "15000 Puffs",
    icon: "🔥",
    priceSingle: 400,
    priceDuo: 750,
    available: false,
    specs: [{ label: "Puffs", value: "Hasta 15000" }],
    flavors: [
      { name: "Berry Bliss", stock: 18 },
      { name: "Black Cherry", stock: 40 },
      { name: "Blueberry Watermelon", stock: 32 },
      { name: "Frozen Apple", stock: 20 },
      { name: "Frozen Blackberry", stock: 34 },
      { name: "Frozen White", stock: 43 },
      { name: "Juicy Peach Ice", stock: 23 },
      { name: "Mexico Mango", stock: 6 },
      { name: "Sour Strawberry", stock: 16 },
    ],
  },
  {
    id: "m_wakaburst36k",
    name: "Waka Burst",
    subtitle: "36000 Puffs",
    icon: "⚡",
    priceSingle: 500,
    priceDuo: 850,
    specs: [{ label: "Puffs", value: "Hasta 36000" }],
    flavors: [
      { name: "Blue Razz Ice", stock: 33 },
      { name: "Blueberry Splash", stock: 27 },
      { name: "Blueberry Watermelon", stock: 23 },
      { name: "Cherry Bomb", stock: 15 },
      { name: "Danonino", stock: 19 },
      { name: "Forest Berries", stock: 27 },
      { name: "Grape Ice", stock: 12 },
      { name: "Mexico Mango", stock: 11 },
      { name: "Miami Mint", stock: 30 },
      { name: "Mr. Blue", stock: 12 },
      { name: "Peach Mango", stock: 28 },
      { name: "Pink Lemonade", stock: 28 },
      { name: "Strawberry Banana", stock: 44 },
      { name: "Strawberry Kiwi", stock: 22 },
      { name: "Strawberry Watermelon", stock: 8 },
      { name: "Tulum Mint", stock: 35 },
      { name: "Watermelon Ice", stock: 40 },
      { name: "White Grape", stock: 13 },
    ],
  },
  {
    id: "m_wakasopro15k",
    name: "Waka So Pro",
    subtitle: "15000 Puffs",
    icon: "🌟",
    priceSingle: 400,
    priceDuo: 750,
    specs: [{ label: "Puffs", value: "Hasta 15000" }],
    flavors: [
      { name: "Black Blue Raz", stock: 30 },
      { name: "Cherry Berry", stock: 11 },
      { name: "Cool Mint", stock: 41 },
      { name: "Fresh Mint", stock: 24 },
      { name: "Icy Green Grape", stock: 45 },
      { name: "Kiwi Dragon Berry", stock: 29 },
      { name: "Mojito Mint", stock: 42 },
      { name: "Peach Blue Raspberry", stock: 18 },
      { name: "Peach Mango Watermelon", stock: 10 },
      { name: "Piña Colada", stock: 8 },
      { name: "Strawberry Burst", stock: 20 },
      { name: "Strawberry Grape", stock: 24 },
      { name: "Strawberry Watermelon", stock: 11 },
      { name: "Watermelon Chill", stock: 20 },
      { name: "Watermelon Kiwi", stock: 12 },
    ],
  },
  {
    id: "m_iplayxboxpromax50k",
    name: "iPlay X Box Pro Max",
    subtitle: "50000 Puffs",
    icon: "💠",
    priceSingle: 600,
    priceDuo: 1000,
    specs: [{ label: "Puffs", value: "Hasta 50000" }],
    flavors: [
      { name: "Black Mint", stock: 30 },
      { name: "Blueberry Cherry", stock: 23 },
      { name: "Blueberry Ice", stock: 35 },
      { name: "Blueberry Watermelon", stock: 29 },
      { name: "Cherry Mint", stock: 16 },
      { name: "Cool Mint", stock: 29 },
      { name: "Double Mint", stock: 28 },
      { name: "Tulum Mint", stock: 19 },
    ],
  },
  {
    id: "m_geekbarmini1500",
    name: "Geek Bar Mini",
    subtitle: "1500 Puffs",
    icon: "🔹",
    priceSingle: 250,
    priceDuo: 400,
    specs: [{ label: "Puffs", value: "Hasta 1500" }],
    flavors: [
      { name: "Alaskan Mint", stock: 23 },
      { name: "Blueberry Ice", stock: 10 },
      { name: "Clear", stock: 44 },
      { name: "Grape Jelly", stock: 16 },
      { name: "Icy Ruby", stock: 40 },
      { name: "Mexico Mango", stock: 21 },
      { name: "Peach Berry", stock: 16 },
      { name: "Piña Colada", stock: 35 },
      { name: "Sour Apple Ice", stock: 30 },
      { name: "Strawberry Banana", stock: 23 },
      { name: "Strawberry Mango", stock: 41 },
      { name: "Watermelon Ice", stock: 20 },
      { name: "White Gummy Ice", stock: 26 },
    ],
  },
  {
    id: "m_geekbarclear50k",
    name: "Geek Bar Clear",
    subtitle: "50000 Puffs",
    icon: "🍑",
    priceSingle: 600,
    priceDuo: 1000,
    specs: [{ label: "Puffs", value: "Hasta 50000" }],
    flavors: [
      { name: "Banana Ice", stock: 9 },
      { name: "Blue Rancher", stock: 20 },
      { name: "Blue Razz Ice", stock: 8 },
      { name: "Cool Mint", stock: 26 },
      { name: "Miami Mint", stock: 31 },
      { name: "Peach Berry", stock: 23 },
      { name: "Sour Gush", stock: 10 },
      { name: "Sour Strawberry", stock: 19 },
      { name: "Triple Berry Ice", stock: 42 },
      { name: "Watermelon Ice", stock: 26 },
    ],
  },
  {
    id: "m_iplayburst45k",
    name: "iPlay Burst",
    subtitle: "45000 Puffs",
    icon: "💎",
    priceSingle: 550,
    priceDuo: 950,
    specs: [{ label: "Puffs", value: "Hasta 45000" }],
    flavors: [
      { name: "Apple Pear", stock: 19 },
      { name: "Blueberry Ice", stock: 37 },
      { name: "Blueberry Mint", stock: 31 },
      { name: "Cool Mint", stock: 35 },
      { name: "Grapefruit Berry", stock: 15 },
      { name: "Juicy Grape", stock: 22 },
      { name: "Kiwi Guava Passion", stock: 14 },
      { name: "Peach Mint", stock: 21 },
      { name: "Raspberry Watermelon", stock: 41 },
      { name: "Strawberry Lychee", stock: 40 },
      { name: "Watermelon Bubble Gum", stock: 22 },
    ],
  },
  {
    id: "m_iplaymax2500",
    name: "iPlay Max",
    subtitle: "2500 Puffs",
    icon: "🌊",
    priceSingle: 250,
    priceDuo: 400,
    available: false,
    specs: [{ label: "Puffs", value: "Hasta 2500" }],
    flavors: [
      { name: "Coconut Strawberry", stock: 43 },
      { name: "Coconut Ice", stock: 33 },
      { name: "Double Mint", stock: 43 },
      { name: "Cool Mint", stock: 31 },
      { name: "Watermelon Banana", stock: 29 },
      { name: "Blue Raz Lemon", stock: 20 },
      { name: "Clear", stock: 14 },
    ],
  },
  {
    id: "m_geekbarpulsex25k",
    name: "Geek Bar Pulse X",
    subtitle: "25000 Puffs",
    icon: "🚀",
    priceSingle: 500,
    priceDuo: 850,
    specs: [{ label: "Puffs", value: "Hasta 25000" }],
    flavors: [
      { name: "Acapulcoco", stock: 38 },
      { name: "Atl Mint", stock: 37 },
      { name: "Banana Taffy Freeze", stock: 11 },
      { name: "Blackberry B-Burst", stock: 9 },
      { name: "Blackberry Blueberry", stock: 13 },
      { name: "Blue Rancher", stock: 15 },
      { name: "Blue Razz Ice", stock: 16 },
      { name: "Blueberry Jam", stock: 33 },
      { name: "Cool Mint", stock: 44 },
      { name: "Grape Slush", stock: 10 },
      { name: "Halls", stock: 30 },
      { name: "Miami Mint", stock: 30 },
      { name: "Peach Jam", stock: 44 },
      { name: "Peach Perfect Slush", stock: 35 },
      { name: "Pink Berry Lemonade", stock: 39 },
      { name: "Pinky Blue", stock: 22 },
      { name: "Raspberry Peach Lime", stock: 41 },
      { name: "Raspberry Jam", stock: 6 },
      { name: "Sour Apple Ice", stock: 13 },
      { name: "Sour Fcuking Fab", stock: 40 },
      { name: "Sour Mango Pineapple", stock: 23 },
      { name: "Sour Straws", stock: 27 },
      { name: "Strawberry B-Burst", stock: 13 },
      { name: "Strawberry Jam", stock: 24 },
      { name: "Strawberry Kiwi Ice", stock: 33 },
      { name: "Strawberry Watermelon", stock: 16 },
      { name: "Watermelon Ice", stock: 35 },
      { name: "White Peach Raspberry", stock: 6 },
      { name: "Wild Cherry Slush", stock: 22 },
    ],
  },
  {
    id: "m_iplayxboxpro15k",
    name: "iPlay X Box Pro",
    subtitle: "15000 Puffs",
    icon: "🔒",
    priceSingle: 400,
    priceDuo: 750,
    available: false,
    specs: [{ label: "Puffs", value: "Hasta 15000" }],
    flavors: [
      { name: "Boing de Mango", stock: 38 },
    ],
  },
];

/* ----------------------------------------------------------------------------
   INVERSIÓN POR MODELO (costo unitario de cada pieza)
   Es lo que nos cuesta comprar una pieza. Se usa SOLO para el reporte de
   ventas: Ganancia = Precio cobrado − Inversión. Si cambia el proveedor o el
   tipo de cambio, se edita aquí y todos los reportes futuros lo toman.
   `null` = todavía no se define el costo; en el reporte sale como "—" y esa
   línea no suma ganancia (para no inventar un número que no es real).
---------------------------------------------------------------------------- */
const MODEL_COST = {
  m_wakasopro15k: 170,        // Waka So Pro 15,000
  m_wakaburst36k: 225,        // Waka Burst 36,000
  m_geekbarpulsex25k: 220,    // Geek Bar Pulse X 25,000
  m_geekbarclear50k: 240,     // Geek Bar Clear 50,000
  m_geekbarmini1500: 100,     // Geek Bar Mini 1,500
  m_geekbarpulse15k: 165,     // Geek Bar Pulse 15,000 — tomado de OFIII.xlsx (código "GEE15", hoja 22-sep)
  m_iplaybigmax: 165,         // iPlay Big Max 5,000
  m_iplayxbox: 145,           // iPlay X Box 4,000
  m_iplayxboxpro15k: 195,     // iPlay X Box Pro 15,000
  m_iplayxboxpromax50k: 240,  // iPlay X Box Pro Max 50,000
  m_iplayburst45k: 215,       // iPlay Burst 45,000
  m_iplaymax2500: 105,        // iPlay Max 2,500 — tomado de OFIII.xlsx (código "IPLAY2500", hoja 07-sep)
};
function modelCost(modelId) {
  const c = MODEL_COST[modelId];
  return typeof c === "number" ? c : null;
}

function buildProductId(modelId, flavor, index) {
  // Si el sabor viene de Supabase trae su propio id real (flavor.productId);
  // si viene del catálogo de ejemplo, se arma uno con la posición, igual que
  // siempre se hizo aquí.
  return flavor.productId || `${modelId}_f${index + 1}`;
}

export let PRODUCTS = MODELS.flatMap((m) =>
  m.flavors.map((flavor, i) => ({
    id: buildProductId(m.id, flavor, i),
    dbId: flavor.dbId ?? null, // id real en la tabla `sabores` de Supabase (null si es catálogo de ejemplo)
    modelId: m.id,
    name: flavor.name,
    description: `${m.name} · ${m.subtitle}`,
    price: m.priceSingle,
    stock: flavor.stock,
    available: m.available !== false && flavor.stock > 0,
    image: "vape",
  }))
);
export let PRODUCTS_BY_MODEL = MODELS.reduce((acc, m) => {
  acc[m.id] = PRODUCTS.filter((p) => p.modelId === m.id);
  return acc;
}, {});
// Stock real por sabor específico (productId -> unidades). Vive en estado
// (ver stockLevels en CustomerHub) para poder descontarse cuando un admin
// confirma un pedido — este objeto es solo el punto de partida.
export let INITIAL_STOCK = Object.fromEntries(PRODUCTS.map((p) => [p.id, p.stock]));

/* ----------------------------------------------------------------------------
   CONECTAR CATÁLOGO REAL DE SUPABASE
   `main.jsx` llama esta función (con los datos ya leídos de las tablas
   `modelos`, `sabores` y `rewards`) ANTES de dibujar la app por primera vez.
   Como MODELS/PRODUCTS/etc. son arreglos y objetos normales de JavaScript,
   "vaciarlos y rellenarlos" así (en vez de crear unos nuevos) hace que todo
   el resto del código — que ya los tenía referenciados desde arriba — vea
   los datos reales sin que haya que tocar cada pantalla una por una.
---------------------------------------------------------------------------- */
export function applyCatalogFromSupabase(newModels, newRewards) {
  MODELS.length = 0;
  MODELS.push(...newModels);

  const newProducts = MODELS.flatMap((m) =>
    m.flavors.map((flavor, i) => ({
      id: buildProductId(m.id, flavor, i),
      dbId: flavor.dbId ?? null,
      modelId: m.id,
      name: flavor.name,
      description: `${m.name} · ${m.subtitle}`,
      price: m.priceSingle,
      stock: flavor.stock,
      available: m.available !== false && flavor.stock > 0,
      image: "vape",
    }))
  );
  PRODUCTS.length = 0;
  PRODUCTS.push(...newProducts);

  const newByModel = MODELS.reduce((acc, m) => {
    acc[m.id] = PRODUCTS.filter((p) => p.modelId === m.id);
    return acc;
  }, {});
  Object.keys(PRODUCTS_BY_MODEL).forEach((k) => delete PRODUCTS_BY_MODEL[k]);
  Object.assign(PRODUCTS_BY_MODEL, newByModel);

  Object.keys(INITIAL_STOCK).forEach((k) => delete INITIAL_STOCK[k]);
  PRODUCTS.forEach((p) => { INITIAL_STOCK[p.id] = p.stock; });

  if (newRewards && newRewards.length) {
    REWARDS.length = 0;
    REWARDS.push(...newRewards);
  }
}

// Disponibilidad EN VIVO: combina que el modelo no esté agotado globalmente
// con el stock real restante de ese sabor (que baja cuando el admin confirma
// un pedido). product.available (el campo estático) es solo el valor inicial.
function isAvailable(product, stockLevels) {
  const model = MODELS.find((m) => m.id === product.modelId);
  if (!model || model.available === false) return false;
  const stock = stockLevels ? (stockLevels[product.id] ?? 0) : product.stock;
  return stock > 0;
}
function remainingStock(product, stockLevels) {
  return stockLevels ? (stockLevels[product.id] ?? 0) : product.stock;
}

const PROMOTIONS = [
  // Desactivada: el 2x de puntos todavía no tiene lógica real detrás (no se
  // aplica al calcular puntos), así que se apaga aquí en vez de borrarla —
  // cuando esa lógica exista, basta con volver a poner active: true.
  { id: "pr1", title: "Puntos dobles esta semana", description: "Todas tus compras suman el doble de puntos hasta el domingo.", startDate: "2026-09-14", endDate: "2026-09-20", type: "bonus", value: "2x", active: false },
  { id: "pr2", title: "Envío sin costo +$600", description: "Pedidos mayores a $600 no pagan envío.", startDate: "2026-09-01", endDate: "2026-09-30", type: "shipping", value: "$0", active: true },
];

export function makeCustomer(over) {
  return {
    id: over.id, name: over.name, phone: over.phone, email: over.email,
    pointsBalance: over.pointsBalance, totalPurchases: over.totalPurchases,
    totalSpent: over.totalSpent, lastPurchase: over.lastPurchase,
    createdAt: over.createdAt, referralCode: over.referralCode,
    // referredBy: id del cliente que lo invitó (se fija al registrarse con un
    // enlace de referido y ya no cambia). referralRewarded: si ya se pagó el
    // premio por su primera compra, para no pagarlo dos veces nunca.
    referredBy: over.referredBy || null,
    referralRewarded: over.referralRewarded || false,
    membershipLevel: over.membershipLevel, status: over.status || "active", password: over.password,
    // origin: cómo se dio de alta este cliente por primera vez — "app" (se registró
    // solo) o "whatsapp" (nació de una venta manual, cuenta provisional). Solo es
    // informativo para reportes; no afecta la lógica de puntos ni de compras.
    origin: over.origin || "app",
  };
}

// Base de clientes reales: arranca vacía. Los clientes de verdad llegan por
// registro/login en Supabase (ver upsertLocalCustomer) o por una venta
// manual registrada desde el panel de admin — nunca hay datos de ejemplo
// precargados aquí.
const INITIAL_CUSTOMERS = [];

const INITIAL_TRANSACTIONS = {};

const INITIAL_ORDERS = {};

const INITIAL_REDEMPTIONS = {};

// Lo ÚNICO que se guarda aquí es cuántas veces compartió su enlace — un dato
// que nadie más puede saber. Registrados, compras y puntos ganados NO se
// guardan: se derivan de los clientes y pedidos reales (ver
// computeReferralStats), así nunca se desincronizan de la realidad.
const INITIAL_REFERRALS = {};

/* ----------------------------------------------------------------------------
   ESTADO REAL DEL PROGRAMA DE REFERIDOS DE UNA PERSONA
   Se calcula leyendo quién trae `referredBy` apuntando a esta persona y si esos
   invitados ya tienen una compra confirmada. Cero contadores que mantener.
---------------------------------------------------------------------------- */
function computeReferralStats(customers, orders, referrerId, invitedCount, dbFriends) {
  const localFriends = customers
    .filter((c) => c.referredBy === referrerId)
    .map((c) => {
      const confirmed = (orders[c.id] || [])
        .filter((o) => o.status === "Completado")
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      return {
        id: c.id,
        name: c.name,
        joinedAt: c.createdAt,
        purchased: confirmed.length > 0,
        firstPurchaseAt: confirmed[0]?.date || null,
        rewarded: !!c.referralRewarded,
      };
    })
    .sort((a, b) => (a.joinedAt < b.joinedAt ? 1 : -1));
  // Lo que dice Supabase (la sesión del cliente no puede leer a los demás clientes,
  // por eso la lista local casi siempre está vacía) manda cuando está disponible.
  const friends = Array.isArray(dbFriends) ? dbFriends : localFriends;

  const purchased = friends.filter((f) => f.purchased).length;
  return {
    invited: Math.max(invitedCount || 0, friends.length),
    registered: friends.length,
    purchased,
    pointsEarned: friends.filter((f) => f.rewarded).length * REFERRAL_POINTS_REFERRER,
    friends,
  };
}

/* ----------------------------------------------------------------------------
   CRÉDITO DE TIENDA
   Cada canje de una recompensa con `creditValue` crea un saldo. La cartera del
   cliente es la suma de los saldos que todavía tienen monto disponible.
---------------------------------------------------------------------------- */
/* ----------------------------------------------------------------------------
   SUGERIDOS DE LA CASA — empuja el stock que menos se mueve
   Ordenamos los sabores por stock restante, de mayor a menor: más stock
   significa que se vende menos rápido, así que son los primeros que
   necesitan salir (misma lógica que "lo próximo a caducar va adelante" en
   una tienda de consumibles). Se le llama "Recomendados" de cara al cliente
   — nunca "más vendidos", porque sería justo lo contrario de la realidad.
---------------------------------------------------------------------------- */
function computeMerchandisingPicks(stockLevels, limit = 6) {
  return PRODUCTS
    .map((p) => ({ product: p, remaining: stockLevels?.[p.id] ?? p.stock }))
    .filter((r) => r.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining)
    .slice(0, limit)
    .map((r) => {
      const model = MODELS.find((m) => m.id === r.product.modelId);
      return { ...r, model };
    });
}

function creditWallet(redemptionList) {
  const entries = (redemptionList || []).filter(
    (r) => typeof r.creditRemaining === "number" && r.creditRemaining > 0
  );
  return {
    available: entries.reduce((s, r) => s + r.creditRemaining, 0),
    entries,
  };
}

// Siguiente hito visible en el hero del dashboard: la recompensa más barata
// del catálogo, para que la meta a la vista sea siempre la más alcanzable.
const NEXT_REWARD_TARGET = Math.min(...REWARDS.filter((r) => r.active).map((r) => r.pointsCost));

/* ============================================================================
   LÓGICA DE CARRITO / PROMOCIÓN POR CANTIDAD (por modelo)
   Regla: dentro de UN MISMO modelo, 1 pieza se cobra al precio individual y
   cada par de piezas (de cualquier sabor de ese modelo, mezclados o no) se
   cobra al precio dúo de ese modelo. Un modelo distinto arma su propio combo
   con su propio precio — las promos nunca se mezclan entre modelos.
   Esto reproduce el "1 x $X / 2 x $Y" que trae cada flyer, respetando que
   cada modelo tiene su propia promoción y su propio catálogo de sabores.
============================================================================ */
function computeCartPricing(cartList) {
  const byModel = {};
  for (const item of cartList) {
    const mid = item.product.modelId;
    (byModel[mid] = byModel[mid] || []).push(item);
  }
  const modelBreakdown = Object.keys(byModel).map((modelId) => {
    const model = MODELS.find((m) => m.id === modelId);
    const items = byModel[modelId];
    const totalQty = items.reduce((s, i) => s + i.qty, 0);
    const bundles = Math.floor(totalQty / 2);
    const remainder = totalQty % 2;
    const total = bundles * model.priceDuo + remainder * model.priceSingle;
    const naiveTotal = totalQty * model.priceSingle;
    const savings = naiveTotal - total;
    return { modelId, model, items, totalQty, bundles, remainder, total, naiveTotal, savings };
  });
  const totalQty = modelBreakdown.reduce((s, m) => s + m.totalQty, 0);
  const total = modelBreakdown.reduce((s, m) => s + m.total, 0);
  const naiveTotal = modelBreakdown.reduce((s, m) => s + m.naiveTotal, 0);
  const savings = modelBreakdown.reduce((s, m) => s + m.savings, 0);
  return { totalQty, total, naiveTotal, savings, modelBreakdown };
}
function describeBundleBreakdown(pricing) {
  if (pricing.modelBreakdown.length === 0) return "";
  return pricing.modelBreakdown
    .map((mb) => {
      const parts = [];
      if (mb.bundles > 0) parts.push(`${mb.bundles} promo${mb.bundles > 1 ? "s" : ""} 2x${formatMoney(mb.model.priceDuo)}`);
      if (mb.remainder > 0) parts.push(`${mb.remainder} individual${mb.remainder > 1 ? "es" : ""} a ${formatMoney(mb.model.priceSingle)}`);
      return `${mb.model.name}: ${parts.join(" + ")}`;
    })
    .join(" · ");
}
function buildCartMessage(cartList, pricing, checkout) {
  const blocks = pricing.modelBreakdown.map((mb) => {
    const lines = mb.items.map((i) => `  - ${i.qty} x ${i.product.name}`);
    const parts = [];
    if (mb.bundles > 0) parts.push(`${mb.bundles} promo 2x${formatMoney(mb.model.priceDuo)}`);
    if (mb.remainder > 0) parts.push(`${mb.remainder} individual`);
    return `${mb.model.name} (${mb.model.subtitle}):\n${lines.join("\n")}\n  Subtotal: ${formatMoney(mb.total)}${parts.length ? " (" + parts.join(" + ") + ")" : ""}`;
  });
  let message = `Hola, quiero hacer este pedido:\n\n${blocks.join("\n\n")}\n\nSubtotal: ${formatMoney(pricing.total)}`;
  if (checkout && checkout.creditUsed > 0) {
    // El mensaje de WhatsApp lleva el desglose para que quien atiende cobre
    // exactamente lo que el cliente vio en pantalla.
    message += `\nCrédito de recompensas aplicado (tope ${Math.round(CREDIT_MAX_PERCENT * 100)}%): -${formatMoney(checkout.creditUsed)}`;
    message += `\nTotal a pagar: ${formatMoney(checkout.toPay)}`;
  } else {
    message += `\nTotal a pagar: ${formatMoney(pricing.total)}`;
  }
  message += `\n\n(El costo de envío se cotiza aparte según la zona de entrega.)`;
  if (checkout) {
    const methodLabel = PAYMENT_METHODS.find((m) => m.id === checkout.paymentMethod)?.label || checkout.paymentMethod;
    message += `\n\nMétodo de pago: ${methodLabel}`;
    message += `\n\nDirección de entrega:\n${checkout.address}`;
    if (checkout.reference && checkout.reference.trim()) {
      message += `\n\nReferencia del lugar: ${checkout.reference.trim()}`;
    }
  }
  return message;
}

/* ============================================================================
   UTILIDADES
============================================================================ */

function formatPoints(n) {
  return n.toLocaleString("es-MX");
}
// Deja solo dígitos, así "55 1234 5678", "5512345678" y "+52 55 1234 5678"
// se consideran el mismo teléfono. Es la llave que identifica a un cliente
// sin importar si compró por la página o por WhatsApp.
export function normalizePhone(phone) {
  return (phone || "").replace(/\D/g, "");
}
function findCustomerByPhone(customers, phone) {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  return customers.find((c) => normalizePhone(c.phone) === norm) || null;
}
function formatMoney(n) {
  return `$${n.toLocaleString("es-MX")}`;
}
function formatDate(d) {
  const date = new Date(d + "T12:00:00");
  return date.toLocaleDateString("es-MX", { day: "numeric", month: "long" });
}
function rewardStatus(reward, balance) {
  if (!reward.active || reward.stock === 0) return "unavailable";
  if (balance >= reward.pointsCost) return "available";
  return "almost";
}

/* ============================================================================
   REPORTES PARA ADMINISTRADORES (agrega customers + orders, ambos ya en
   estado de la app). Con el estado actual (useState en memoria del navegador)
   esto solo agrega lo que ese navegador conoce — ver nota de arquitectura
   sobre backend al final del archivo para que estos números reflejen a TODOS
   los clientes reales, no solo la sesión local.
============================================================================ */
/* ============================================================================
   ESTADÍSTICAS POR DÍA + REPORTE EN EXCEL
   Se calculan agrupando los mismos pedidos confirmados por su fecha — el día
   de hoy siempre queda "al momento" porque se recalcula solo con cada pedido
   nuevo que se confirma, sin ningún cierre manual de por medio.
============================================================================ */
function computeDailyStats(customers, orders) {
  const allOrders = Object.entries(orders).flatMap(([customerId, list]) =>
    list.map((o) => ({ ...o, customerId }))
  );
  const confirmedOrders = allOrders.filter((o) => o.status === "Completado");

  const byDate = {};
  for (const o of confirmedOrders) {
    if (!byDate[o.date]) {
      byDate[o.date] = { date: o.date, orders: [], revenue: 0, units: 0, appOrders: 0, waOrders: 0, creditUsed: 0 };
    }
    const bucket = byDate[o.date];
    bucket.orders.push(o);
    bucket.revenue += o.total;
    bucket.creditUsed += o.creditUsed || 0;
    bucket.units += (o.items || []).reduce((s, i) => s + i.qty, 0);
    if (o.origin === "whatsapp") bucket.waOrders += 1; else bucket.appOrders += 1;
  }

  return Object.values(byDate).sort((a, b) => (a.date < b.date ? 1 : -1));
}

/* ----------------------------------------------------------------------------
   REPORTE DE VENTAS EN EXCEL — UNO SOLO, DE TODO EL PERIODO
   No se genera un archivo por venta: se juntan TODOS los pedidos confirmados
   del rango elegido (hoy, últimos 7 días, mes o histórico) en una sola hoja
   con el formato fijo:

     Pedido | Producto | Cant. | Precio | Método de pago | Inversión | Ganancia

   Un renglón por producto. El número de pedido (Pedido 1, Pedido 2, …) solo
   aparece en el primer renglón de cada pedido, así se lee agrupado.
   Requiere la librería "xlsx" (SheetJS): npm install xlsx
---------------------------------------------------------------------------- */

const PAYMENT_LABEL = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  terminal: "Terminal",
};
function paymentLabel(id) {
  if (!id) return "No registrado";
  return PAYMENT_LABEL[id] || id;
}

// El total del pedido puede traer promo 2x, así que no siempre es la suma de
// precio × cantidad. Repartimos el total real entre los renglones en la misma
// proporción, para que la columna "Precio" sume exactamente lo que se cobró.
function orderLines(order) {
  const items = order.items || [];
  const gross = items.reduce((s, i) => s + i.price * i.qty, 0);
  // Se reparte el SUBTOTAL (antes del crédito de recompensas) para que el
  // precio de cada producto sea el precio real de venta. El crédito baja
  // aparte, en su propio renglón, para que se vea de dónde salió el descuento.
  const base = typeof order.subtotal === "number" ? order.subtotal : order.total;
  const factor = gross > 0 && typeof base === "number" ? base / gross : 1;
  let assigned = 0;
  return items.map((it, idx) => {
    const raw = it.price * it.qty * factor;
    // El último renglón absorbe el redondeo para que cuadre al peso.
    const charged = idx === items.length - 1
      ? Math.round((base ?? gross) - assigned)
      : Math.round(raw);
    assigned += charged;
    const model = MODELS.find((m) => m.id === it.modelId);
    const unitCost = modelCost(it.modelId);
    const invest = unitCost === null ? null : unitCost * it.qty;
    return {
      product: model ? `${model.name} ${model.subtitle} — ${it.name}` : it.name,
      qty: it.qty,
      charged,
      invest,
      profit: invest === null ? null : charged - invest,
      modelId: it.modelId,
      modelName: model ? `${model.name} ${model.subtitle}` : "Otro",
    };
  });
}

// Junta los pedidos confirmados del rango y devuelve todo lo que necesita el Excel.
function buildSalesReport(customers, orders, { from, to } = {}) {
  const all = Object.entries(orders).flatMap(([customerId, list]) =>
    list.map((o) => ({ ...o, customerId }))
  );
  const rows = all
    .filter((o) => o.status === "Completado")
    .filter((o) => (!from || o.date >= from) && (!to || o.date <= to))
    .sort((a, b) => (a.date === b.date ? (a.id > b.id ? 1 : -1) : a.date < b.date ? -1 : 1));

  const customerById = (id) => customers.find((c) => c.id === id);
  const report = rows.map((o, i) => {
    const lines = orderLines(o);
    if (o.creditUsed > 0) {
      // Renglón negativo: así la columna Precio sigue sumando exactamente lo
      // que entró a caja, y queda documentado que se usó una recompensa.
      lines.push({
        product: "Crédito de recompensas aplicado",
        qty: "",
        charged: -o.creditUsed,
        invest: null,
        profit: -o.creditUsed,
        modelId: null,
        modelName: "Crédito de recompensas",
        isCredit: true,
      });
    }
    return { label: `Pedido ${i + 1}`, order: o, customer: customerById(o.customerId), lines };
  });

  const totals = report.reduce(
    (acc, r) => {
      for (const l of r.lines) {
        if (l.isCredit) { acc.revenue += l.charged; acc.credit += -l.charged; acc.profit += l.profit; continue; }
        acc.units += l.qty;
        acc.revenue += l.charged;
        if (l.invest !== null) { acc.invest += l.invest; acc.profit += l.profit; }
        else acc.missingCost = true;
      }
      return acc;
    },
    { units: 0, revenue: 0, invest: 0, profit: 0, credit: 0, missingCost: false }
  );

  return { report, totals, count: report.length };
}

function exportSalesReport(customers, orders, { from, to, rangeLabel } = {}) {
  const { report, totals } = buildSalesReport(customers, orders, { from, to });
  const generated = new Date();

  const head = [
    ["THE KING SHOP — REPORTE DE VENTAS"],
    ["Periodo", rangeLabel || "Histórico completo"],
    ["Generado", generated.toLocaleString("es-MX")],
    [],
    ["Pedido", "Producto", "Cant.", "Precio", "Método de pago", "Inversión", "Ganancia"],
  ];

  const body = [];
  for (const r of report) {
    r.lines.forEach((l, idx) => {
      body.push([
        idx === 0 ? r.label : "",
        l.product,
        l.qty,
        l.charged,
        idx === 0 ? paymentLabel(r.order.paymentMethod) : "",
        l.invest === null ? "—" : l.invest,
        l.profit === null ? "—" : l.profit,
      ]);
    });
  }

  const foot = [
    [],
    ["TOTALES", "", totals.units, totals.revenue, "", totals.invest, totals.profit],
  ];
  if (totals.missingCost) {
    foot.push([]);
    foot.push(["Nota", "Hay modelos sin inversión capturada (marcados con “—”). No suman en Inversión ni en Ganancia."]);
  }

  const sheet = XLSX.utils.aoa_to_sheet([...head, ...body, ...foot]);
  sheet["!cols"] = [
    { wch: 11 }, { wch: 40 }, { wch: 6 }, { wch: 12 },
    { wch: 16 }, { wch: 12 }, { wch: 12 },
  ];
  sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 6 } }];
  // Formato de moneda en las columnas de dinero (D, F, G).
  const firstDataRow = head.length; // 0-indexed: el renglón siguiente al encabezado
  const lastRow = head.length + body.length + foot.length;
  for (let r = firstDataRow; r <= lastRow; r++) {
    for (const c of [3, 5, 6]) {
      const ref = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[ref];
      if (cell && typeof cell.v === "number") cell.z = '"$"#,##0';
    }
  }

  // Segunda hoja: resumen por modelo y por método de pago, para ver de un
  // vistazo qué se movió y cómo pagó la gente.
  const byModel = {};
  const byPayment = {};
  for (const r of report) {
    const pm = paymentLabel(r.order.paymentMethod);
    for (const l of r.lines) {
      if (l.isCredit) { (byPayment[pm] ||= { orders: 0, revenue: 0 }).revenue += l.charged; continue; }
      const m = (byModel[l.modelName] ||= { units: 0, revenue: 0, invest: 0, profit: 0 });
      m.units += l.qty; m.revenue += l.charged;
      if (l.invest !== null) { m.invest += l.invest; m.profit += l.profit; }
      const p = (byPayment[pm] ||= { orders: 0, revenue: 0 });
      p.revenue += l.charged;
    }
    (byPayment[pm] ||= { orders: 0, revenue: 0 }).orders += 1;
  }

  const summary = XLSX.utils.aoa_to_sheet([
    ["Resumen del periodo"],
    ["Periodo", rangeLabel || "Histórico completo"],
    [],
    ["Pedidos", report.length],
    ["Piezas vendidas", totals.units],
    ["Venta total (lo que entró)", totals.revenue],
    ["Crédito de recompensas aplicado", totals.credit],
    ["Inversión total", totals.invest],
    ["Ganancia total", totals.profit],
    ["Ticket promedio", report.length ? Math.round(totals.revenue / report.length) : 0],
    [],
    ["Por modelo", "Piezas", "Venta", "Inversión", "Ganancia"],
    ...Object.entries(byModel)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .map(([name, v]) => [name, v.units, v.revenue, v.invest, v.profit]),
    [],
    ["Por método de pago", "Pedidos", "Venta"],
    ...Object.entries(byPayment).map(([name, v]) => [name, v.orders, v.revenue]),
  ]);
  summary["!cols"] = [{ wch: 30 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Ventas");
  XLSX.utils.book_append_sheet(wb, summary, "Resumen");

  const stamp = to && from === to ? from : `${from || "inicio"}_a_${to || generated.toISOString().slice(0, 10)}`;
  XLSX.writeFile(wb, `reporte-ventas-${stamp}.xlsx`);
  return report.length;
}

function computeAdminStats(customers, orders) {
  const allOrders = Object.entries(orders).flatMap(([customerId, list]) =>
    list.map((o) => ({ ...o, customerId }))
  );
  // Solo lo confirmado cuenta como venta real — un pedido "Pendiente" todavía
  // puede cambiar o cancelarse en WhatsApp, así que no debe inflar ingresos,
  // ticket promedio ni popularidad de modelos/sabores.
  const confirmedOrders = allOrders.filter((o) => o.status === "Completado");
  const pendingOrders = allOrders.filter((o) => o.status === "Pendiente");
  const customerById = (id) => customers.find((c) => c.id === id);

  const totalRevenue = customers.reduce((s, c) => s + (c.totalSpent || 0), 0);
  const totalOrders = confirmedOrders.length;
  const avgOrderValue = totalOrders > 0 ? Math.round(totalRevenue / totalOrders) : 0;
  const pointsOutstanding = customers.reduce((s, c) => s + (c.pointsBalance || 0), 0);
  const avgPurchasesPerCustomer = customers.length > 0
    ? (customers.reduce((s, c) => s + (c.totalPurchases || 0), 0) / customers.length)
    : 0;
  const avgLTV = customers.length > 0 ? Math.round(totalRevenue / customers.length) : 0;
  const totalUnitsSold = confirmedOrders.reduce((s, o) => s + (o.items || []).reduce((s2, it) => s2 + it.qty, 0), 0);
  const avgUnitsPerOrder = totalOrders > 0 ? (totalUnitsSold / totalOrders) : 0;

  const topCustomers = [...customers]
    .sort((a, b) => (b.totalSpent || 0) - (a.totalSpent || 0))
    .slice(0, 5);

  const membershipBreakdown = customers.reduce((acc, c) => {
    acc[c.membershipLevel] = (acc[c.membershipLevel] || 0) + 1;
    return acc;
  }, {});

  const modelQty = {};
  const flavorQty = {};
  const modelBuyers = {}; // modelId -> [{ customerName, date, qty, flavor }]
  const flavorBuyers = {}; // flavorName -> [{ customerName, date, qty }]
  for (const o of confirmedOrders) {
    const customerName = customerById(o.customerId)?.name || "Cliente";
    for (const item of o.items || []) {
      if (item.modelId) {
        modelQty[item.modelId] = (modelQty[item.modelId] || 0) + item.qty;
        (modelBuyers[item.modelId] ||= []).push({ customerName, date: o.date, qty: item.qty, flavor: item.name });
      }
      flavorQty[item.name] = (flavorQty[item.name] || 0) + item.qty;
      (flavorBuyers[item.name] ||= []).push({ customerName, date: o.date, qty: item.qty });
    }
  }
  const modelPopularity = Object.entries(modelQty)
    .map(([modelId, qty]) => ({ model: MODELS.find((m) => m.id === modelId), qty, buyers: modelBuyers[modelId] }))
    .filter((r) => r.model)
    .sort((a, b) => b.qty - a.qty);
  const flavorPopularity = Object.entries(flavorQty)
    .map(([name, qty]) => ({ name, qty, buyers: flavorBuyers[name] }))
    .sort((a, b) => b.qty - a.qty);

  const maxModelQty = modelPopularity.length > 0 ? modelPopularity[0].qty : 0;
  const maxFlavorQty = flavorPopularity.length > 0 ? flavorPopularity[0].qty : 0;

  // Canal de venta: pedidos sin "origin" son de antes de tener este campo y
  // se cuentan como "app" (nacieron del carrito de la página).
  const appOrders = confirmedOrders.filter((o) => (o.origin || "app") === "app");
  const whatsappOrders = confirmedOrders.filter((o) => o.origin === "whatsapp");
  const channelBreakdown = {
    app: { orders: appOrders.length, revenue: appOrders.reduce((s, o) => s + o.total, 0) },
    whatsapp: { orders: whatsappOrders.length, revenue: whatsappOrders.reduce((s, o) => s + o.total, 0) },
  };

  // Clientes "Sin registrar": nacieron de una venta manual y todavía no
  // reclaman su cuenta en la página. Es la cola de trabajo de migración.
  const provisionalCustomers = customers
    .filter((c) => c.status === "provisional")
    .sort((a, b) => (b.totalSpent || 0) - (a.totalSpent || 0));

  return {
    totalCustomers: customers.length,
    totalRevenue, totalOrders, avgOrderValue, pointsOutstanding, avgPurchasesPerCustomer,
    avgLTV, totalUnitsSold, avgUnitsPerOrder,
    topCustomers, membershipBreakdown, modelPopularity, flavorPopularity, maxModelQty, maxFlavorQty,
    pendingOrders, allOrders, channelBreakdown, provisionalCustomers,
  };
}

/* ============================================================================
   ÍCONOS DE PRODUCTO/RECOMPENSA (ilustraciones simples en SVG, sin dependencias)
============================================================================ */
function ArtIcon({ kind, className }) {
  const common = { className, strokeWidth: 1.5 };
  switch (kind) {
    case "cash": return <Sparkles {...common} />;
    case "headphones": return <div className={className} style={{ fontSize: 28 }}>🎧</div>;
    case "airpods": return <div className={className} style={{ fontSize: 28 }}>🎧</div>;
    case "speaker": return <div className={className} style={{ fontSize: 28 }}>🔊</div>;
    case "credit": return <div className={className} style={{ fontSize: 28 }}>💳</div>;
    case "thermos": return <div className={className} style={{ fontSize: 28 }}>🧴</div>;
    case "kit": return <div className={className} style={{ fontSize: 28 }}>🎁</div>;
    case "vape": return <div className={className} style={{ fontSize: 28 }}>💨</div>;
    case "bag": return <div className={className} style={{ fontSize: 28 }}>☕</div>;
    case "box": return <div className={className} style={{ fontSize: 28 }}>📦</div>;
    case "mug": return <div className={className} style={{ fontSize: 28 }}>🍵</div>;
    case "sub": return <div className={className} style={{ fontSize: 28 }}>📬</div>;
    default: return <Gift {...common} />;
  }
}

/* ============================================================================
   COMPONENTE PRINCIPAL
============================================================================ */

export default function CustomerHub() {
  const [customers, setCustomers] = useState(INITIAL_CUSTOMERS);
  const [transactions, setTransactions] = useState(INITIAL_TRANSACTIONS);
  const [orders, setOrders] = useState(INITIAL_ORDERS);
  const [redemptions, setRedemptions] = useState(INITIAL_REDEMPTIONS);
  const [referrals, setReferrals] = useState(INITIAL_REFERRALS);
  const [referralFriends, setReferralFriends] = useState({}); // invitados reales, por cliente (desde Supabase)
  const [stockLevels, setStockLevels] = useState(INITIAL_STOCK);
  // MODELS/PRODUCTS son arreglos de módulo (no estado de React), así que
  // mutarlos (agregar/renombrar/borrar un modelo o un sabor) no dispara un
  // repintado por sí solo. Este contador es la señal: cada vez que sube,
  // los componentes que leen MODELS/PRODUCTS (el editor de productos, el
  // catálogo, stock, venta manual) se vuelven a dibujar con los datos ya
  // actualizados.
  const [catalogVersion, setCatalogVersion] = useState(0);
  const bumpCatalog = () => setCatalogVersion((v) => v + 1);

  // Código de referido con el que llegó la visita (de la URL o de una visita
  // anterior guardada). Se "gasta" al registrarse: ahí se convierte en el
  // vínculo permanente `referredBy` del cliente nuevo.
  const [pendingReferral, setPendingReferral] = useState(null);

  // Sesión de administrador: separada por completo de currentUser (un cliente
  // logueado NUNCA es automáticamente administrador). Vive en sessionStorage
  // para no pedir el código en cada clic, pero se pierde al cerrar la pestaña.
  const [adminAuthed, setAdminAuthed] = useState(() => {
    try { return sessionStorage.getItem(ADMIN_SESSION_KEY) === "1"; } catch (e) { return false; }
  });
  function grantAdminAccess() {
    setAdminAuthed(true);
    try { sessionStorage.setItem(ADMIN_SESSION_KEY, "1"); } catch (e) { /* ignorar */ }
  }
  function revokeAdminAccess() {
    setAdminAuthed(false);
    try { sessionStorage.removeItem(ADMIN_SESSION_KEY); } catch (e) { /* ignorar */ }
    signOutAdmin();
    navigate("landing");
  }

  const [currentUserId, setCurrentUserId] = useState(null);
  const [view, setView] = useState("landing");
  const [history, setHistory] = useState([]);
  const [selectedProductId, setSelectedProductId] = useState(null);
  const [redeemModal, setRedeemModal] = useState(null); // { rewardId, step: 'confirm'|'success', code }
  const [toast, setToast] = useState(null);
  const [pointsFilter, setPointsFilter] = useState("all");
  const [menuOpen, setMenuOpen] = useState(false);
  const [authIntent, setAuthIntent] = useState(null); // where to go after login
  const [cart, setCart] = useState({}); // { productId: qty }
  const [checkoutInfo, setCheckoutInfo] = useState({ paymentMethod: "", address: "", reference: "", useCredit: true });
  const [lastOrder, setLastOrder] = useState(null);
  const [catalogTab, setCatalogTab] = useState(MODELS[0].id);
  const [ageVerified, setAgeVerified] = useState(() => {
    try { return localStorage.getItem("ch_age_verified") === "1"; } catch { return false; }
  });
  const [ageDenied, setAgeDenied] = useState(false);

  function confirmAge(isAdult) {
    if (isAdult) {
      try { localStorage.setItem("ch_age_verified", "1"); } catch {}
      setAgeDenied(false);
      setAgeVerified(true);
    } else {
      setAgeDenied(true);
    }
  }

  const currentUser = customers.find((c) => c.id === currentUserId) || null;

  function navigate(next) {
    setHistory((h) => [...h, view]);
    setView(next);
    setMenuOpen(false);
    window.scrollTo?.(0, 0);
  }
  function goBack() {
    setHistory((h) => {
      if (h.length === 0) { setView("dashboard"); return h; }
      const copy = [...h];
      const prev = copy.pop();
      setView(prev);
      return copy;
    });
  }

  function showToast(msg, ms = 2200) {
    setToast(msg);
    window.clearTimeout(showToast._t);
    showToast._t = window.setTimeout(() => setToast(null), ms);
  }

  const PROTECTED = ["dashboard", "pointsHistory", "orders", "referrals", "profile", "myRewards"];

  function requireAuth(target) {
    if (currentUser) { navigate(target); return; }
    setAuthIntent(target);
    navigate("login");
  }

  /* ------------------------------------------------------------------
     SEGUIMIENTO DE REFERIDOS — paso 1: detectar con quién llegó la visita.
     Corre una sola vez al abrir la página. Si la URL trae ?ref=CODIGO
     (o /r/CODIGO) lo guarda; si no, recupera el de una visita anterior.
     A partir de aquí el código viaja con la persona hasta que se registra,
     aunque navegue por el catálogo, cierre la pestaña y vuelva mañana.
  ------------------------------------------------------------------ */
  useEffect(() => {
    const fromUrl = readReferralFromUrl();
    if (fromUrl) { storeReferral(fromUrl); setPendingReferral(fromUrl); return; }
    const stored = loadStoredReferral();
    if (stored) setPendingReferral(stored);
  }, []);

  // Segunda puerta oculta, para quien prefiera un enlace directo en vez del
  // toque en el logo: abrir la página con ?staff=1 lleva a pedir el código,
  // sin pasar por el menú ni por ninguna pantalla de cliente.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get("staff") === "1") setView("adminGate");
    } catch (e) { /* entorno sin window/URL */ }
  }, []);

  // Recargar el panel de admin no debe pedir correo y contraseña otra vez: la
  // sesión real de Supabase ya está guardada en el navegador. Si venías del
  // panel (o abres el enlace ?staff=1) y esa sesión sigue siendo de un
  // administrador, se abre directo el panel. Si ya no es válida, se limpia la
  // marca local para no mostrar un panel sin permisos reales.
  useEffect(() => {
    let wantsAdmin = false;
    try {
      wantsAdmin = sessionStorage.getItem(ADMIN_SESSION_KEY) === "1" ||
        new URL(window.location.href).searchParams.get("staff") === "1";
    } catch (e) { /* sin window/URL */ }
    if (!wantsAdmin) return;
    let active = true;
    hasActiveAdminSession().then((ok) => {
      if (!active) return;
      if (ok) {
        grantAdminAccess();
        setView("admin");
      } else {
        setAdminAuthed(false);
        try { sessionStorage.removeItem(ADMIN_SESSION_KEY); } catch (e) { /* ignorar */ }
      }
    });
    return () => { active = false; };
  }, []);

  // El dueño del código, si existe y es una cuenta activa. Antes esto se
  // buscaba solo entre los clientes de ejemplo ya cargados en memoria; ahora
  // se pregunta de verdad a Supabase, porque el dueño del código puede ser
  // cualquier cliente real, no solo uno que ya hayamos cargado en esta sesión.
  const [referrer, setReferrer] = useState(null);
  useEffect(() => {
    let active = true;
    if (!pendingReferral) { setReferrer(null); return; }
    findReferrerByCode(pendingReferral).then((r) => { if (active) setReferrer(r); });
    return () => { active = false; };
  }, [pendingReferral]);

  /* ------------------------------------------------------------------
     SEGUIMIENTO DE REFERIDOS — paso 3: pagar el premio.
     Se dispara en la PRIMERA compra confirmada del invitado, venga de la
     página o de una venta manual por WhatsApp. `referralRewarded` garantiza
     que se pague una sola vez en la vida de esa cuenta.
  ------------------------------------------------------------------ */
  async function awardReferralIfFirstPurchase(customerId, dbId) {
    const invitee = customers.find((c) => c.id === customerId);
    if (!invitee || !invitee.referredBy || invitee.referralRewarded) return;
    const clienteDbId = dbId ?? invitee.dbId;
    if (clienteDbId == null) return;

    // La regla real vive en la base (primera compra confirmada, una sola vez):
    // así el premio se guarda de verdad para los dos y no se puede repetir.
    const result = await awardReferralInDb(clienteDbId, REFERRAL_POINTS_REFERRER, REFERRAL_POINTS_REFERRED);
    if (result.error) { console.warn("awardReferral:", result.error); showToast("⚠️ " + result.error, 7000); return; }
    if (!result.awarded) return;

    setCustomers((cs) => cs.map((c) => {
      if (c.dbId != null && c.dbId === result.referrerId) return { ...c, pointsBalance: c.pointsBalance + REFERRAL_POINTS_REFERRER };
      if (c.id === customerId) return { ...c, pointsBalance: c.pointsBalance + REFERRAL_POINTS_REFERRED, referralRewarded: true };
      return c;
    }));
    showToast(`Referido acreditado: +${REFERRAL_POINTS_REFERRER} pts para ${result.referrerName || "el referidor"}`, 4000);
  }

  // Mete (o actualiza) un cliente real de Supabase dentro del mismo arreglo
  // `customers` que ya usaba toda la app — así el resto del código (puntos,
  // pedidos, referidos) no nota ninguna diferencia entre un cliente de
  // ejemplo y uno real.
  function upsertLocalCustomer(customer) {
    setCustomers((cs) => {
      const idx = cs.findIndex((c) => c.id === customer.id);
      if (idx === -1) return [...cs, customer];
      const copy = [...cs];
      copy[idx] = { ...copy[idx], ...customer };
      return copy;
    });
    setTransactions((t) => ({ ...t, [customer.id]: t[customer.id] || [] }));
    setOrders((o) => ({ ...o, [customer.id]: o[customer.id] || [] }));
    setRedemptions((r) => ({ ...r, [customer.id]: r[customer.id] || [] }));
    setReferrals((r) => ({ ...r, [customer.id]: r[customer.id] || { invited: 0 } }));
  }

  // Trae TODOS los pedidos reales (pendientes y completados, de cualquier
  // cliente, hechos desde cualquier dispositivo) directo de Supabase y los
  // mete al mismo estado `orders`/`customers` que ya usaba toda la app. Sin
  // esto, "Pedidos por confirmar", el historial y las estadísticas del panel
  // solo mostraban lo que había pasado en la pestaña donde se confirmó cada
  // pedido — vacío en cualquier otro dispositivo o después de recargar.
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [rewardsToDeliver, setRewardsToDeliver] = useState([]);
  const [adminSoundOn, setAdminSoundOn] = useState(() => {
    try { return window.localStorage.getItem("king_admin_sound") !== "off"; } catch (e) { return true; }
  });
  const adminSoundRef = useRef(adminSoundOn);
  adminSoundRef.current = adminSoundOn;
  function toggleAdminSound() {
    const next = !adminSoundOn;
    setAdminSoundOn(next);
    try { window.localStorage.setItem("king_admin_sound", next ? "on" : "off"); } catch (e) { /* ok */ }
    if (next) { unlockBell(); playBell(1); }
  }
  const seenPendingRef = useRef(null);      // ids de pedidos pendientes ya vistos (null = aún no se ha cargado nada)
  const seenRewardsRef = useRef(null);      // ídem para recompensas por entregar
  const refreshingRef = useRef(false);      // evita dos lecturas al mismo tiempo
  const [newOrdersBadge, setNewOrdersBadge] = useState(0);
  async function refreshOrdersFromSupabase({ silent = false } = {}) {
    if (refreshingRef.current) return { ok: true, skipped: true };
    refreshingRef.current = true;
    if (!silent) setOrdersLoading(true);
    const result = await loadOrdersWithCustomers();
    const pendingRewards = await loadPendingRedemptions();
    if (pendingRewards.ok) setRewardsToDeliver(pendingRewards.items);
    if (!silent) setOrdersLoading(false);
    refreshingRef.current = false;
    if (result.error) { console.warn("refreshOrdersFromSupabase:", result.error); return result; }

    // Aviso de pedidos nuevos: compara contra lo ya visto. La primera lectura
    // solo memoriza (no suena por pedidos que ya estaban ahí).
    const pendingNow = new Set(result.orders.filter((o) => o.status === "Pendiente").map((o) => o.dbOrderId));
    const rewardsNow = new Set((pendingRewards.ok ? pendingRewards.items : []).map((r) => r.dbId));
    if (seenPendingRef.current !== null) {
      const freshOrders = [...pendingNow].filter((id) => !seenPendingRef.current.has(id)).length;
      const freshRewards = seenRewardsRef.current ? [...rewardsNow].filter((id) => !seenRewardsRef.current.has(id)).length : 0;
      if (freshOrders + freshRewards > 0) {
        setNewOrdersBadge((n) => n + freshOrders + freshRewards);
        if (adminSoundRef.current) playBell(3);
        showToast(freshOrders > 0
          ? `🔔 ${freshOrders === 1 ? "Pedido nuevo" : freshOrders + " pedidos nuevos"} por confirmar`
          : "🔔 Nueva recompensa por entregar", 6000);
      }
    }
    seenPendingRef.current = pendingNow;
    seenRewardsRef.current = rewardsNow;

    for (const customer of result.customers) upsertLocalCustomer(customer);

    setOrders((prev) => {
      const next = { ...prev };
      const byCustomer = {};
      for (const order of result.orders) (byCustomer[order.customerId] ||= []).push(order);
      for (const [customerId, dbOrders] of Object.entries(byCustomer)) {
        const dbIds = new Set(dbOrders.map((o) => o.dbOrderId));
        // Conserva cualquier pedido que solo exista en esta pestaña (por
        // ejemplo, uno que se intentó guardar en Supabase y falló) — nunca lo
        // borra, solo evita duplicarlo una vez que ya se sincronizó.
        const localOnly = (prev[customerId] || []).filter((o) => o.dbOrderId == null ? !o.synced : !dbIds.has(o.dbOrderId));
        next[customerId] = [...dbOrders, ...localOnly];
      }
      return next;
    });
    return { ok: true, diag: result.diag };
  }

  async function markRewardDelivered(canjeDbId) {
    const r = await markRedemptionFulfilled(canjeDbId);
    if (r.error) return r;
    setRewardsToDeliver((list) => list.filter((x) => x.dbId !== canjeDbId));
    showToast("Recompensa marcada como entregada");
    return { ok: true };
  }

  // Se carga sola apenas se entra al panel de admin (incluyendo cuando la
  // sesión de admin ya venía guardada de antes y la pantalla abre directo en
  // "admin" tras recargar) — así el admin nunca tiene que adivinar si lo que
  // ve es la realidad o solo lo que pasó en su propia pestaña.
  useEffect(() => {
    if (adminAuthed) refreshOrdersFromSupabase();
  }, [adminAuthed]);

  // Refresco automático del panel: cada ADMIN_POLL_MS revisa Supabase sin
  // mostrar "Actualizando…", y al volver a la pestaña revisa de inmediato.
  useEffect(() => {
    if (!adminAuthed) { seenPendingRef.current = null; seenRewardsRef.current = null; return; }
    const unlock = () => unlockBell();
    window.addEventListener("pointerdown", unlock, { once: true });
    const timer = window.setInterval(() => refreshOrdersFromSupabase({ silent: true }), ADMIN_POLL_MS);
    const onVisible = () => { if (!document.hidden) refreshOrdersFromSupabase({ silent: true }); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pointerdown", unlock);
    };
  }, [adminAuthed]);

  // Número de pedidos nuevos en el título de la pestaña (se limpia al mirar el panel).
  useEffect(() => {
    const base = "The King Shop";
    document.title = newOrdersBadge > 0 ? `(${newOrdersBadge}) 🔔 ${base}` : base;
  }, [newOrdersBadge]);
  useEffect(() => {
    if (view === "admin" && newOrdersBadge > 0 && !document.hidden) {
      const t = window.setTimeout(() => setNewOrdersBadge(0), 4000);
      return () => window.clearTimeout(t);
    }
  }, [view, newOrdersBadge]);

  // Al abrir la app: si el navegador ya tenía una sesión iniciada (no cerró
  // sesión la última vez), la recuperamos solos, sin que tenga que volver a
  // escribir su correo y contraseña.
  useEffect(() => {
    let active = true;
    getActiveSessionCustomer().then((customer) => {
      if (!active || !customer) return;
      upsertLocalCustomer(customer);
      setCurrentUserId(customer.id);
    });
    return () => { active = false; };
  }, []);

  // Historial real del cliente: al abrir la app con sesión, al iniciar sesión
  // y justo después de guardar un pedido nuevo. Sin esto "Mis pedidos" solo
  // mostraba lo hecho en esa misma pestaña y quedaba vacío al recargar.
  async function refreshMyOrders(customerId) {
    const result = await loadMyOrders();
    if (result.error) { console.warn("refreshMyOrders:", result.error); return; }
    setOrders((prev) => {
      const dbIds = new Set(result.orders.map((o) => o.dbOrderId));
      const localOnly = (prev[customerId] || []).filter((o) => o.dbOrderId == null ? !o.synced : !dbIds.has(o.dbOrderId));
      return { ...prev, [customerId]: [...result.orders, ...localOnly] };
    });
  }

  // Movimientos de puntos y canjes/crédito reales del cliente, más su perfil
  // (puntos actuales). Todo viene de Supabase: lo local solo es un reflejo.
  async function refreshMyAccount(customerId) {
    const [rd, tx, profile, rf] = await Promise.all([loadMyRedemptions(), loadMyTransactions(), getActiveSessionCustomer(), loadMyReferrals()]);
    if (rf.error) console.warn("refreshMyAccount:", rf.error);
    else setReferralFriends((f) => ({ ...f, [customerId]: rf.friends }));
    if (rd.error) console.warn("refreshMyAccount:", rd.error);
    else setRedemptions((r) => ({ ...r, [customerId]: rd.redemptions }));
    if (tx.error) console.warn("refreshMyAccount:", tx.error);
    else setTransactions((t) => ({ ...t, [customerId]: tx.transactions }));
    if (profile && profile.id === customerId) upsertLocalCustomer(profile);
  }

  useEffect(() => {
    if (currentUser?.dbId) { refreshMyOrders(currentUser.id); refreshMyAccount(currentUser.id); }
  }, [currentUser?.id, currentUser?.dbId]);

  useEffect(() => {
    if (view === "checkout" && !currentUser) requireAuth("checkout");
  }, [view, currentUser]);

  function handleLogin(customerId) {
    setCurrentUserId(customerId);
    showToast(`Bienvenido, ${customers.find((c) => c.id === customerId)?.name}`);
    setHistory([]);
    setView(authIntent || "dashboard");
    setAuthIntent(null);
  }

  // Login real: verifica correo y contraseña contra Supabase Auth. Regresa
  // { error } si algo falla, para que la pantalla de login lo muestre.
  async function handleAuthLogin({ email, password }) {
    const result = await signInCustomer({ email, password });
    if (result.error) return { error: result.error };
    upsertLocalCustomer(result.customer);
    handleLogin(result.customer.id);
  }

  async function handleLogout() {
    await signOutCustomer();
    setCurrentUserId(null);
    setHistory([]);
    setView("landing");
  }

  // Registro real: crea la cuenta en Supabase Auth y su renglón en
  // `clientes` (o reclama uno provisional que ya existía por una venta
  // manual con ese mismo teléfono). Regresa { error } si algo falla.
  async function handleRegister(form) {
    const referrerCode = referrer?.code || null;
    const result = await registerCustomer({
      name: form.name, phone: form.phone, email: form.email, password: form.password,
      referrerCode,
    });
    if (result.error) return { error: result.error };

    if (result.needsEmailConfirmation) {
      showToast("Cuenta creada. Revisa tu correo para confirmarla antes de iniciar sesión.");
      navigate("login");
      return;
    }

    upsertLocalCustomer(result.customer);
    if (referrerCode) {
      clearStoredReferral();
      setPendingReferral(null);
      showToast(`Te invitó ${referrer?.name || ""} — sus puntos se acreditan con tu primera compra`);
    }
    setCurrentUserId(result.customer.id);
    setHistory([]);
    const backTo = authIntent;
    setAuthIntent(null);
    setView(backTo || "onboarding");
  }


  function changeCartQty(productId, delta) {
    setCart((c) => {
      const current = c[productId] || 0;
      const cap = stockLevels[productId] ?? 0;
      const next = delta > 0 ? Math.min(cap, current + delta) : Math.max(0, current + delta);
      const copy = { ...c };
      if (next === 0) delete copy[productId]; else copy[productId] = next;
      return copy;
    });
  }
  // Igual que changeCartQty pero con confirmación visual — se usa en el catálogo,
  // donde se puede sumar cantidad de varios sabores sin entrar al detalle de cada uno.
  function changeCartQtyWithToast(productId, delta) {
    changeCartQty(productId, delta);
    if (delta > 0) {
      const product = PRODUCTS.find((p) => p.id === productId);
      const newQty = (cart[productId] || 0) + delta;
      showToast(`Añadiste ${product?.name} · ahora llevas ${newQty} en tu pedido`);
    }
  }
  const cartList = useMemo(
    () => Object.entries(cart).map(([id, qty]) => ({ product: PRODUCTS.find((p) => p.id === id), qty })).filter((i) => i.product && i.qty > 0),
    [cart]
  );
  const cartCount = cartList.reduce((s, i) => s + i.qty, 0);
  const cartPricing = useMemo(() => computeCartPricing(cartList), [cartList]);

  function confirmCartOrder(checkout) {
    if (cartList.length === 0) return;
    if (!currentUser) { requireAuth("checkout"); return; }
    const pricing = computeCartPricing(cartList);
    const today = new Date().toISOString().slice(0, 10);
    const delivery = {
      paymentMethod: checkout?.paymentMethod || "",
      address: checkout?.address || "",
      reference: checkout?.reference || "",
    };
    if (currentUser) {
      // CRÉDITO DE TIENDA: se aplica completo (el cliente no elige el monto),
      // hasta donde alcance el pedido. El saldo se aparta en este momento —
      // no al confirmar el pago — para que no se pueda gastar el mismo
      // crédito en dos pedidos abiertos a la vez. Si el pedido se cancela,
      // el saldo regresa intacto (ver cancelOrder).
      const wallet = creditWallet(redemptions[currentUser.id]);
      const subtotal = pricing.total;
      const creditUsed = checkout?.useCredit ? creditAppliedFor(subtotal, wallet.available) : 0;
      const total = subtotal - creditUsed;
      // Los puntos se ganan sobre lo que realmente se paga, no sobre el
      // subtotal: si no, el crédito se convertiría en una fábrica de puntos.
      const pointsEarned = Math.round(total * POINTS_PER_PURCHASE_RATE);
      const orderId = "o_" + Date.now();
      const items = cartList.map((i) => ({ productId: i.product.id, name: i.product.name, qty: i.qty, modelId: i.product.modelId, price: i.product.price }));
      if (creditUsed > 0) spendCredit(currentUser.id, creditUsed, orderId);
      // El pedido nace "Pendiente": todavía no se descuenta stock ni se otorgan
      // puntos/gasto — eso solo pasa cuando un administrador confirma que el
      // pago se realizó (ver confirmOrder), porque el cliente puede cambiar
      // cantidades/sabores al negociar por WhatsApp.
      setOrders((o) => ({
        ...o,
        [currentUser.id]: [{ id: orderId, date: today, subtotal, creditUsed, total, status: "Pendiente", pointsEarned, items, origin: "app", dbOrderId: null, ...delivery }, ...(o[currentUser.id] || [])],
      }));
      setLastOrder({ items, pricing, subtotal, creditUsed, total, pointsEarned, date: today, ...delivery });
      // Guarda el pedido en Supabase en segundo plano — sin bloquear la
      // redirección a WhatsApp que sigue justo después de esto. Así, aunque
      // el cliente nunca vuelva a abrir esta pestaña, el pedido ya le
      // aparece al admin en "Pedidos por confirmar" desde cualquier
      // dispositivo (antes solo vivía en la memoria del navegador del
      // cliente). Si falla, el pedido sigue visible aquí igual — solo se
      // avisa en consola para depurar, no se le muestra un error al cliente
      // porque su pedido de todas formas ya se mandó por WhatsApp.
      savePendingOrderToSupabase(currentUser, orderId, { items, subtotal, creditUsed, total, pointsEarned, delivery });
    } else {
      setLastOrder({ items: cartList.map((i) => ({ name: i.product.name, qty: i.qty })), pricing, subtotal: pricing.total, creditUsed: 0, total: pricing.total, pointsEarned: null, date: today, guest: true, ...delivery });
    }
    setCart({});
    setCheckoutInfo({ paymentMethod: "", address: "", reference: "", useCredit: true });
  }

  // Actualiza campos de sincronización (dbOrderId / syncError) de un pedido
  // local, sin tocar nada más de lo que el cliente ya está viendo.
  function setOrderSyncState(customerId, localOrderId, patch) {
    setOrders((o) => ({
      ...o,
      [customerId]: (o[customerId] || []).map((ord) => ord.id === localOrderId ? { ...ord, ...patch } : ord),
    }));
  }

  async function savePendingOrderToSupabase(customer, localOrderId, { items, subtotal, creditUsed, total, pointsEarned, delivery }) {
    // Cualquier falla (incluso una excepción inesperada) deja el motivo
    // guardado EN el pedido, para verlo en "Mis pedidos" aunque el aviso
    // flotante ya haya desaparecido.
    const fail = (msg) => {
      console.warn("No se pudo guardar el pedido pendiente en Supabase:", msg);
      setOrderSyncState(customer.id, localOrderId, { syncError: msg });
      showToast("⚠️ El pedido se envió por WhatsApp pero no se sincronizó con el panel. Revisa Mis pedidos.");
    };
    try {
      const clienteResult = await ensureClienteRow({
        dbId: customer.dbId, phone: customer.phone, name: customer.name, origin: customer.origin,
      });
      if (clienteResult.error) return fail(clienteResult.error);
      if (clienteResult.dbId && clienteResult.dbId !== customer.dbId) {
        setCustomers((cs) => cs.map((c) => c.id === customer.id ? { ...c, dbId: clienteResult.dbId } : c));
      }

      const resolvedItems = items.map((item) => ({
        ...item,
        dbId: PRODUCTS.find((p) => p.id === item.productId)?.dbId ?? null,
      }));

      const result = await createPendingOrder({
        clienteDbId: clienteResult.dbId,
        items: resolvedItems,
        subtotal, creditUsed, total, pointsEarned,
        paymentMethod: delivery.paymentMethod, address: delivery.address, reference: delivery.reference,
      });
      if (result.error) return fail(result.error);

      setOrderSyncState(customer.id, localOrderId, { dbOrderId: result.pedidoId, syncError: null, synced: true });
      refreshMyOrders(customer.id); // trae el id real y deja el historial igual al de Supabase
      refreshMyAccount(customer.id); // crédito apartado real
    } catch (err) {
      fail("Error inesperado: " + (err?.message || String(err)));
    }
  }

  // Botón "Reintentar" de Mis pedidos: vuelve a mandar al panel un pedido que
  // no se pudo sincronizar la primera vez.
  function retryOrderSync(order) {
    if (!currentUser) return;
    setOrderSyncState(currentUser.id, order.id, { syncError: null });
    showToast("Reintentando sincronizar el pedido…");
    savePendingOrderToSupabase(currentUser, order.id, {
      items: order.items, subtotal: order.subtotal, creditUsed: order.creditUsed || 0,
      total: order.total, pointsEarned: order.pointsEarned,
      delivery: { paymentMethod: order.paymentMethod, address: order.address, reference: order.reference },
    });
  }

  /* ------------------------------------------------------------------
     MOVIMIENTOS DEL CRÉDITO DE TIENDA
     El saldo vive dentro del canje que lo generó, no en un campo suelto del
     cliente: así siempre se sabe de qué recompensa salió cada peso y cuándo
     se usó. Se consume en orden de antigüedad.
  ------------------------------------------------------------------ */
  function spendCredit(customerId, amount, orderId) {
    setRedemptions((all) => {
      let left = amount;
      const list = (all[customerId] || []).map((r) => {
        if (left <= 0 || !r.creditRemaining) return r;
        const take = Math.min(r.creditRemaining, left);
        left -= take;
        const remaining = r.creditRemaining - take;
        return {
          ...r,
          creditRemaining: remaining,
          status: remaining === 0 ? "USADA" : "DISPONIBLE",
          usedOn: [...(r.usedOn || []), { orderId, amount: take, date: new Date().toISOString().slice(0, 10) }],
        };
      });
      return { ...all, [customerId]: list };
    });
  }

  // Devuelve a la cuenta lo que ese pedido había apartado (pedido cancelado).
  function releaseCredit(customerId, orderId) {
    setRedemptions((all) => ({
      ...all,
      [customerId]: (all[customerId] || []).map((r) => {
        const used = (r.usedOn || []).filter((u) => u.orderId === orderId);
        if (used.length === 0) return r;
        const back = used.reduce((sm, u) => sm + u.amount, 0);
        return {
          ...r,
          creditRemaining: (r.creditRemaining || 0) + back,
          status: "DISPONIBLE",
          usedOn: (r.usedOn || []).filter((u) => u.orderId !== orderId),
        };
      }),
    }));
  }

  /* -------------------- Acciones del panel de administrador -------------------- */

  // Guarda en Supabase (con pequeña espera para agrupar clics seguidos en +/–)
  // el estado más reciente del pedido pendiente que el admin está ajustando.
  const orderEditTimers = useRef({});
  const ordersLatest = useRef(orders);
  ordersLatest.current = orders;
  function persistOrderEdit(customerId, orderId) {
    window.clearTimeout(orderEditTimers.current[orderId]);
    orderEditTimers.current[orderId] = window.setTimeout(async () => {
      const ord = (ordersLatest.current[customerId] || []).find((o) => o.id === orderId);
      if (!ord || ord.dbOrderId == null || ord.status !== "Pendiente") return;
      const r = await updatePendingOrderItems(ord.dbOrderId, {
        items: ord.items, subtotal: ord.subtotal, creditUsed: ord.creditUsed, total: ord.total, pointsEarned: ord.pointsEarned,
      });
      if (r.error) { console.warn("persistOrderEdit:", r.error); showToast("⚠️ " + r.error, 6000); }
    }, 600);
  }

  function updateOrderItemQty(customerId, orderId, itemIndex, newQty) {
    persistOrderEdit(customerId, orderId);
    setOrders((o) => ({
      ...o,
      [customerId]: (o[customerId] || []).map((ord) => {
        if (ord.id !== orderId) return ord;
        const items = ord.items.map((it, idx) => idx === itemIndex ? { ...it, qty: Math.max(0, newQty) } : it)
          .filter((it) => it.qty > 0);
        const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
        const creditUsed = Math.min(ord.creditUsed || 0, subtotal);
        const total = subtotal - creditUsed;
        return { ...ord, items, subtotal, creditUsed, total, pointsEarned: Math.round(total * POINTS_PER_PURCHASE_RATE) };
      }),
    }));
  }

  // Confirma un pedido: primero lo guarda de verdad en Supabase (pedido +
  // stock + totales del cliente + movimiento de puntos, ver recordSale) y
  // SOLO si eso funciona lo refleja en pantalla — así nunca se otorgan
  // puntos ni se descuenta stock por un pedido que en realidad no se guardó.
  async function confirmOrder(customerId, orderId) {
    const order = (orders[customerId] || []).find((o) => o.id === orderId);
    if (!order || order.status !== "Pendiente") return { ok: false, error: "Este pedido ya no está pendiente." };
    const customer = customers.find((c) => c.id === customerId);
    if (!customer) return { ok: false, error: "No se encontró al cliente." };

    const resolvedItems = order.items.map((item) => {
      const pid = item.productId ?? PRODUCTS.find((p) => p.modelId === item.modelId && p.name === item.name)?.id;
      const product = PRODUCTS.find((p) => p.id === pid);
      return { ...item, productId: pid, dbId: product?.dbId ?? null };
    });

    const clienteResult = await ensureClienteRow({
      dbId: customer.dbId, phone: customer.phone, name: customer.name, origin: customer.origin,
    });
    if (clienteResult.error) return { ok: false, error: clienteResult.error };

    const saleResult = await recordSale({
      pedidoId: order.dbOrderId ?? null,
      clienteDbId: clienteResult.dbId,
      items: resolvedItems,
      subtotal: order.subtotal,
      creditUsed: order.creditUsed,
      total: order.total,
      pointsEarned: order.pointsEarned,
      origin: "app",
      paymentMethod: order.paymentMethod,
      address: order.address,
      reference: order.reference,
      currentPoints: customer.pointsBalance,
      currentPurchases: customer.totalPurchases,
      currentSpent: customer.totalSpent,
    });
    if (saleResult.error) return { ok: false, error: saleResult.error };
    window.clearTimeout(orderEditTimers.current[orderId]);

    const today = new Date().toISOString().slice(0, 10);

    // Descuenta stock real por sabor específico, sin bajar de 0 (reflejo en
    // pantalla del mismo descuento que recordSale ya guardó en Supabase).
    setStockLevels((s) => {
      const next = { ...s };
      for (const item of resolvedItems) {
        if (item.productId != null) next[item.productId] = Math.max(0, (next[item.productId] ?? 0) - item.qty);
      }
      return next;
    });

    setOrders((o) => ({
      ...o,
      [customerId]: (o[customerId] || []).map((ord) => ord.id === orderId ? { ...ord, status: "Completado", dbOrderId: saleResult.pedidoId ?? ord.dbOrderId } : ord),
    }));

    setCustomers((cs) => cs.map((c) => c.id === customerId
      ? {
          ...c,
          dbId: clienteResult.dbId,
          pointsBalance: c.pointsBalance + order.pointsEarned,
          totalPurchases: c.totalPurchases + 1,
          totalSpent: c.totalSpent + order.total,
          lastPurchase: today,
        }
      : c));

    setTransactions((t) => ({
      ...t,
      [customerId]: [{ id: "t_" + Date.now(), type: "purchase", amount: order.pointsEarned, description: `Pedido confirmado — ${order.items.reduce((s, i) => s + i.qty, 0)} producto${order.items.reduce((s, i) => s + i.qty, 0) > 1 ? "s" : ""}`, relatedOrderId: orderId, createdAt: today }, ...(t[customerId] || [])],
    }));

    // Si era la primera compra de un invitado, aquí se le pagan los puntos
    // a quien lo trajo. Funciona igual si el pedido tardó semanas en cerrarse.
    awardReferralIfFirstPurchase(customerId, clienteResult.dbId);

    // Si algo secundario no se pudo guardar (stock, puntos, movimiento), se
    // avisa claro en vez de dejar la pantalla mostrando algo que no es real.
    if (saleResult.warnings && saleResult.warnings.length > 0) {
      showToast("⚠️ Pedido confirmado, pero " + saleResult.warnings.join("; ") + ". Revisa los permisos en Supabase.", 9000);
    }
    return { ok: true };
  }

  // Registra una venta que se cerró fuera de la página (típicamente por
  // WhatsApp). Es el punto único de control del que hablamos: pasa por el
  // MISMO stockLevels y las MISMAS reglas de puntos que confirmOrder, así que
  // nunca hay "stock de la página" contra "stock de WhatsApp" — hay un solo
  // número. El teléfono es la llave: si ya existe un cliente con ese
  // teléfono (activo o provisional), la venta se suma a esa cuenta; si no
  // existe, se crea una cuenta provisional ("Sin registrar") que empieza a
  // acumular puntos e historial desde ya, lista para que el cliente la
  // reclame cuando se registre en la página con el mismo número.
  async function registerManualSale({ phone, name, cartList, paymentMethod }) {
    const cleanPhone = (phone || "").trim();
    if (!cleanPhone) return { ok: false, error: "Captura el teléfono del cliente." };
    if (!cartList || cartList.length === 0) return { ok: false, error: "Agrega al menos un producto." };

    const pricing = computeCartPricing(cartList);
    const today = new Date().toISOString().slice(0, 10);
    const pointsEarned = Math.round(pricing.total * POINTS_PER_PURCHASE_RATE);
    const items = cartList.map((i) => ({ productId: i.product.id, name: i.product.name, qty: i.qty, modelId: i.product.modelId, price: i.product.price, dbId: i.product.dbId ?? null }));
    const orderId = "o_wa_" + Date.now();

    // El teléfono es la llave real: se busca primero en Supabase (no solo en
    // el estado local, que se pierde si la página se recargó) para no crear
    // una cuenta duplicada de alguien que ya existe.
    const existingLocal = findCustomerByPhone(customers, cleanPhone);
    const clienteResult = await ensureClienteRow({
      dbId: existingLocal?.dbId, phone: cleanPhone, name: name?.trim(), origin: "whatsapp",
    });
    if (clienteResult.error) return { ok: false, error: clienteResult.error };

    const existing = existingLocal || (clienteResult.existing ? customers.find((c) => c.dbId === clienteResult.dbId) : null);
    const customerId = existing ? existing.id : "c_prov_" + Date.now();
    const isNew = !clienteResult.existing;

    if (!existing) {
      const provisionalCustomer = {
        ...makeCustomer({
          id: customerId, name: name?.trim() || "Cliente sin registrar", phone: cleanPhone, email: null,
          pointsBalance: 0, totalPurchases: 0, totalSpent: 0, lastPurchase: null,
          createdAt: today, referralCode: null, membershipLevel: "Bienvenida",
          password: null, status: "provisional", origin: "whatsapp",
        }),
        dbId: clienteResult.dbId,
      };
      setCustomers((cs) => [...cs, provisionalCustomer]);
      setTransactions((t) => ({ ...t, [customerId]: [] }));
      setOrders((o) => ({ ...o, [customerId]: [] }));
      setRedemptions((r) => ({ ...r, [customerId]: [] }));
      setReferrals((r) => ({ ...r, [customerId]: { invited: 0 } }));
    }

    const currentCustomer = existing || { pointsBalance: 0, totalPurchases: 0, totalSpent: 0 };
    const saleResult = await recordSale({
      clienteDbId: clienteResult.dbId,
      items,
      subtotal: pricing.total,
      creditUsed: 0,
      total: pricing.total,
      pointsEarned,
      origin: "whatsapp",
      paymentMethod,
      currentPoints: currentCustomer.pointsBalance,
      currentPurchases: currentCustomer.totalPurchases,
      currentSpent: currentCustomer.totalSpent,
    });
    if (saleResult.error) return { ok: false, error: saleResult.error };
    if (saleResult.warnings && saleResult.warnings.length > 0) {
      showToast("⚠️ Venta guardada, pero " + saleResult.warnings.join("; ") + ". Revisa los permisos en Supabase.", 9000);
    }

    // Mismo punto único de control que confirmOrder: descuenta del mismo stock real.
    setStockLevels((s) => {
      const next = { ...s };
      for (const item of items) next[item.productId] = Math.max(0, (next[item.productId] ?? 0) - item.qty);
      return next;
    });

    // La venta manual nace ya "Completado" — a diferencia de un pedido de la
    // página, aquí el pago ya se recibió al momento de registrarla.
    setOrders((o) => ({
      ...o,
      [customerId]: [{ id: orderId, date: today, total: pricing.total, status: "Completado", pointsEarned, items, origin: "whatsapp", paymentMethod: paymentMethod || "" }, ...(o[customerId] || [])],
    }));

    setCustomers((cs) => cs.map((c) => c.id === customerId
      ? { ...c, dbId: clienteResult.dbId, pointsBalance: c.pointsBalance + pointsEarned, totalPurchases: c.totalPurchases + 1, totalSpent: c.totalSpent + pricing.total, lastPurchase: today }
      : c));

    const unitCount = items.reduce((s, i) => s + i.qty, 0);
    setTransactions((t) => ({
      ...t,
      [customerId]: [{ id: "t_" + Date.now(), type: "purchase", amount: pointsEarned, description: `Venta manual (WhatsApp) — ${unitCount} producto${unitCount > 1 ? "s" : ""}`, relatedOrderId: orderId, createdAt: today }, ...(t[customerId] || [])],
    }));

    // Misma regla que en la página: si es la primera compra de alguien que
    // llegó por invitación, el referidor cobra sus puntos aunque la venta se
    // haya cerrado por WhatsApp.
    if (existing) awardReferralIfFirstPurchase(customerId, clienteResult.dbId);

    return { ok: true, isNew, customerId, pointsEarned, total: pricing.total };
  }

  // Único punto de escritura de stock "de catálogo" (reposiciones y
  // correcciones manuales del admin) — a diferencia de confirmOrder y
  // registerManualSale, que SOLO restan por una venta real, esta función deja
  // que el admin ponga el número exacto que hay físicamente (subir o bajar).
  // Guarda primero en Supabase (tabla `sabores`, columna `stock`) y solo si
  // eso funciona lo refleja en pantalla — así la página nunca muestra un
  // número que en realidad no se guardó, y cualquier otra persona que abra
  // la página (o la vuelva a cargar) ve el mismo stock real, no el de su
  // propia sesión.
  async function setProductStock(productId, newStock) {
    const product = PRODUCTS.find((p) => p.id === productId);
    if (!product) return { ok: false, error: "Producto no encontrado." };
    const clean = Math.max(0, Math.round(Number(newStock) || 0));

    if (product.dbId != null) {
      try {
        // .select() al final hace que Supabase regrese los renglones que de
        // verdad tocó. Si regresa vacío, el UPDATE "funcionó" (sin error)
        // pero no encontró ningún renglón con ese id — eso es justo lo que
        // antes se veía como "Guardado" aunque nada cambiara en la base.
        const { data, error } = await supabase
          .from("sabores")
          .update({ stock: clean })
          .eq("id", product.dbId)
          .select("id, stock");

        if (error) return { ok: false, error: "No se pudo guardar en Supabase: " + error.message };
        if (!data || data.length === 0) {
          return {
            ok: false,
            error: `No se guardó el stock de "${product.name}". Puede que tu sesión de administrador haya caducado (sal del panel y vuelve a entrar) o que ese sabor ya no exista en Supabase.`,
          };
        }
      } catch (err) {
        return { ok: false, error: "Sin conexión con Supabase. Revisa tu internet e intenta de nuevo." };
      }
    } else {
      // Este sabor no trae un id real de Supabase (viene del catálogo de
      // ejemplo) — el cambio solo puede quedar en esta sesión del navegador.
      console.warn(`setProductStock: "${product.name}" no tiene dbId, el cambio no se guarda en Supabase.`);
    }

    // Mantiene PRODUCTS/INITIAL_STOCK (los arreglos "de catálogo") en el
    // mismo número, para que si se recarga la página antes del próximo
    // fetch, no se vea un valor viejo por un instante.
    product.stock = clean;
    setStockLevels((s) => ({ ...s, [productId]: clean }));
    return { ok: true, offline: product.dbId == null };
  }

  /* --------------------------------------------------------------------
     EDITOR DE PRODUCTOS (modelos y sabores)
     Mismo criterio que setProductStock: si el modelo/sabor tiene dbId
     (viene de Supabase), la escritura va primero a la tabla real
     (`modelos` / `sabores`) y solo si eso funciona se refleja en pantalla.
     Si es catálogo de ejemplo (sin dbId), el cambio queda solo en esta
     sesión del navegador y se avisa con offline:true, igual que el stock.
  -------------------------------------------------------------------- */
  async function addModel({ name, subtitle, priceSingle, priceDuo }) {
    const clean = {
      name: (name || "").trim(),
      subtitle: (subtitle || "").trim(),
      priceSingle: Math.max(0, Math.round(Number(priceSingle) || 0)),
      priceDuo: Math.max(0, Math.round(Number(priceDuo) || 0)),
    };
    if (!clean.name) return { ok: false, error: "Ponle un nombre al modelo." };

    let dbId = null;
    try {
      const { data, error } = await supabase
        .from("modelos")
        .insert({ name: clean.name, subtitle: clean.subtitle, price_single: clean.priceSingle, price_duo: clean.priceDuo, active: true, sort_order: MODELS.length })
        .select("id")
        .single();
      if (error) throw error;
      dbId = data.id;
    } catch (err) {
      console.warn("addModel: no se pudo guardar en Supabase, se agrega solo en esta sesión.", err);
    }

    MODELS.push({
      id: dbId != null ? `m_${dbId}` : `m_local_${Date.now()}`,
      dbId,
      name: clean.name,
      subtitle: clean.subtitle,
      icon: "💨",
      priceSingle: clean.priceSingle,
      priceDuo: clean.priceDuo,
      specs: [],
      flavors: [],
    });
    PRODUCTS_BY_MODEL[MODELS[MODELS.length - 1].id] = [];
    bumpCatalog();
    return { ok: true, offline: dbId == null };
  }

  async function updateModel(modelId, changes) {
    const model = MODELS.find((m) => m.id === modelId);
    if (!model) return { ok: false, error: "Modelo no encontrado." };
    const clean = {};
    if (changes.name != null) clean.name = String(changes.name).trim();
    if (changes.subtitle != null) clean.subtitle = String(changes.subtitle).trim();
    if (changes.priceSingle != null) clean.priceSingle = Math.max(0, Math.round(Number(changes.priceSingle) || 0));
    if (changes.priceDuo != null) clean.priceDuo = Math.max(0, Math.round(Number(changes.priceDuo) || 0));
    if (clean.name === "") return { ok: false, error: "El nombre no puede quedar vacío." };

    if (model.dbId != null) {
      try {
        const dbChanges = {};
        if (clean.name != null) dbChanges.name = clean.name;
        if (clean.subtitle != null) dbChanges.subtitle = clean.subtitle;
        if (clean.priceSingle != null) dbChanges.price_single = clean.priceSingle;
        if (clean.priceDuo != null) dbChanges.price_duo = clean.priceDuo;
        const { data, error } = await supabase.from("modelos").update(dbChanges).eq("id", model.dbId).select("id");
        if (error) return { ok: false, error: "No se pudo guardar en Supabase: " + error.message };
        if (!data || data.length === 0) return { ok: false, error: `No existe en Supabase el modelo id=${model.dbId}.` };
      } catch (err) {
        return { ok: false, error: "Sin conexión con Supabase. Intenta de nuevo." };
      }
    }

    Object.assign(model, clean);
    // El precio vive en el modelo, así que los productos ya armados
    // (PRODUCTS/PRODUCTS_BY_MODEL) traen su propia copia de `price` y hay
    // que refrescarla para que el carrito y el catálogo cobren lo nuevo.
    if (clean.priceSingle != null) {
      PRODUCTS.filter((p) => p.modelId === modelId).forEach((p) => { p.price = clean.priceSingle; });
    }
    bumpCatalog();
    return { ok: true, offline: model.dbId == null };
  }

  async function deleteModel(modelId) {
    const model = MODELS.find((m) => m.id === modelId);
    if (!model) return { ok: false, error: "Modelo no encontrado." };

    if (model.dbId != null) {
      try {
        // Borra primero los sabores del modelo (llave foránea) y luego el modelo.
        const { error: errSabores } = await supabase.from("sabores").delete().eq("model_id", model.dbId);
        if (errSabores) return { ok: false, error: "No se pudo borrar en Supabase: " + errSabores.message };
        const { error: errModelo } = await supabase.from("modelos").delete().eq("id", model.dbId);
        if (errModelo) return { ok: false, error: "No se pudo borrar en Supabase: " + errModelo.message };
      } catch (err) {
        return { ok: false, error: "Sin conexión con Supabase. Intenta de nuevo." };
      }
    }

    const idx = MODELS.findIndex((m) => m.id === modelId);
    if (idx !== -1) MODELS.splice(idx, 1);
    for (let i = PRODUCTS.length - 1; i >= 0; i--) {
      if (PRODUCTS[i].modelId === modelId) PRODUCTS.splice(i, 1);
    }
    delete PRODUCTS_BY_MODEL[modelId];
    bumpCatalog();
    return { ok: true, offline: model.dbId == null };
  }

  async function addFlavor(modelId, { name, stock }) {
    const model = MODELS.find((m) => m.id === modelId);
    if (!model) return { ok: false, error: "Modelo no encontrado." };
    const cleanName = (name || "").trim();
    if (!cleanName) return { ok: false, error: "Ponle un nombre al sabor." };
    const cleanStock = Math.max(0, Math.round(Number(stock) || 0));

    let dbId = null;
    if (model.dbId != null) {
      try {
        const { data, error } = await supabase.from("sabores").insert({ model_id: model.dbId, name: cleanName, stock: cleanStock }).select("id").single();
        if (error) throw error;
        dbId = data.id;
      } catch (err) {
        console.warn("addFlavor: no se pudo guardar en Supabase, se agrega solo en esta sesión.", err);
      }
    }

    const flavor = { name: cleanName, stock: cleanStock, dbId, productId: dbId != null ? `f_${dbId}` : undefined };
    model.flavors.push(flavor);
    const newProduct = {
      id: buildProductId(model.id, flavor, model.flavors.length - 1),
      dbId,
      modelId: model.id,
      name: cleanName,
      description: `${model.name} · ${model.subtitle}`,
      price: model.priceSingle,
      stock: cleanStock,
      available: model.available !== false && cleanStock > 0,
      image: "vape",
    };
    PRODUCTS.push(newProduct);
    (PRODUCTS_BY_MODEL[model.id] = PRODUCTS_BY_MODEL[model.id] || []).push(newProduct);
    INITIAL_STOCK[newProduct.id] = cleanStock;
    setStockLevels((s) => ({ ...s, [newProduct.id]: cleanStock }));
    bumpCatalog();
    return { ok: true, offline: dbId == null };
  }

  async function deleteFlavor(productId) {
    const product = PRODUCTS.find((p) => p.id === productId);
    if (!product) return { ok: false, error: "Sabor no encontrado." };

    if (product.dbId != null) {
      try {
        const { error } = await supabase.from("sabores").delete().eq("id", product.dbId);
        if (error) return { ok: false, error: "No se pudo borrar en Supabase: " + error.message };
      } catch (err) {
        return { ok: false, error: "Sin conexión con Supabase. Intenta de nuevo." };
      }
    }

    const model = MODELS.find((m) => m.id === product.modelId);
    if (model) {
      const fIdx = model.flavors.findIndex((f) => (f.dbId != null ? f.dbId === product.dbId : f.name === product.name));
      if (fIdx !== -1) model.flavors.splice(fIdx, 1);
    }
    const pIdx = PRODUCTS.findIndex((p) => p.id === productId);
    if (pIdx !== -1) PRODUCTS.splice(pIdx, 1);
    if (PRODUCTS_BY_MODEL[product.modelId]) {
      PRODUCTS_BY_MODEL[product.modelId] = PRODUCTS_BY_MODEL[product.modelId].filter((p) => p.id !== productId);
    }
    delete INITIAL_STOCK[productId];
    setStockLevels((s) => { const next = { ...s }; delete next[productId]; return next; });
    bumpCatalog();
    return { ok: true, offline: product.dbId == null };
  }

  // Cancela un pedido pendiente. Primero se guarda en Supabase y SOLO si eso
  // funciona se refleja en pantalla — así nunca se ve "Cancelado" algo que
  // en la base sigue pendiente (y reaparece al actualizar).
  async function cancelOrder(customerId, orderId) {
    const order = (orders[customerId] || []).find((o) => o.id === orderId);
    if (!order) return { ok: false, error: "No se encontró el pedido." };
    if (order.status !== "Pendiente") return { ok: false, error: "Este pedido ya no está pendiente." };

    if (order.dbOrderId != null) {
      const r = await updateOrderStatus(order.dbOrderId, "Cancelado");
      if (r.error) {
        console.warn("cancelOrder:", r.error);
        return { ok: false, error: r.error };
      }
    }
    window.clearTimeout(orderEditTimers.current[orderId]);
    if (order.creditUsed > 0) {
      releaseCredit(customerId, orderId);
      const rel = await releaseOrderCredit(order.dbOrderId);
      if (rel.error) showToast("⚠️ Pedido cancelado, pero " + rel.error, 8000);
    }
    setOrders((o) => ({
      ...o,
      [customerId]: (o[customerId] || []).map((ord) => ord.id === orderId ? { ...ord, status: "Cancelado" } : ord),
    }));
    showToast("Pedido cancelado");
    return { ok: true };
  }

  function openRedeem(reward) {
    if (!currentUser) { setAuthIntent("rewards"); navigate("login"); return; }
    setRedeemModal({ rewardId: reward.id, step: "confirm" });
  }
  // Canje real: la base descuenta los puntos, crea el canje y el movimiento en
  // una sola operación. Solo si funciona se muestra el éxito — antes solo
  // cambiaba la pantalla y al recargar los puntos "regresaban".
  const [redeeming, setRedeeming] = useState(false);
  async function confirmRedeem() {
    const reward = REWARDS.find((r) => r.id === redeemModal.rewardId);
    if (!reward || !currentUser || redeeming) return;
    setRedeeming(true);
    const result = await redeemReward({ rewardId: reward.id, pointsCost: reward.pointsCost, creditValue: reward.creditValue });
    setRedeeming(false);
    if (result.error) {
      showToast("⚠️ No se pudo canjear: " + result.error, 6000);
      return;
    }
    await refreshMyAccount(currentUser.id);
    setRedeemModal({ rewardId: reward.id, step: "success", code: result.redemption.code });
  }

  const myTransactions = currentUser ? (transactions[currentUser.id] || []) : [];
  const myOrders = currentUser ? (orders[currentUser.id] || []) : [];
  const myRedemptions = currentUser ? (redemptions[currentUser.id] || []) : [];
  const myWallet = useMemo(() => creditWallet(myRedemptions), [myRedemptions]);
  const merchandisingPicks = useMemo(() => computeMerchandisingPicks(stockLevels), [stockLevels]);
  const myReferralStats = useMemo(
    () => currentUser ? computeReferralStats(customers, orders, currentUser.id, referrals[currentUser.id]?.invited, referralFriends[currentUser.id]) : null,
    [currentUser, customers, orders, referrals, referralFriends]
  );

  const filteredTx = useMemo(() => {
    if (pointsFilter === "all") return myTransactions;
    if (pointsFilter === "earned") return myTransactions.filter((t) => t.amount > 0);
    if (pointsFilter === "used") return myTransactions.filter((t) => t.amount < 0);
    if (pointsFilter === "bonus") return myTransactions.filter((t) => t.type === "bonus" || t.type === "referral");
    return myTransactions;
  }, [myTransactions, pointsFilter]);

  const showChrome = view !== "login" && view !== "register" && view !== "onboarding" && view !== "adminGate" && view !== "admin";
  const showBottomNav = showChrome;

  return (
    <div className="ch-root">
      <GlobalStyle />

      {!ageVerified ? (
        <AgeGate denied={ageDenied} onConfirm={confirmAge} />
      ) : (
      <>
      {showChrome && (
        <>
          <Header
            currentUser={currentUser}
            onNav={(v) => (PROTECTED.includes(v) ? requireAuth(v) : navigate(v))}
            onLogin={() => navigate("login")}
            setMenuOpen={setMenuOpen}
            onSecretAdmin={() => navigate("adminGate")}
          />
          <SideMenu
            open={menuOpen}
            currentUser={currentUser}
            onNav={(v) => (PROTECTED.includes(v) ? requireAuth(v) : navigate(v))}
            onLogout={handleLogout}
            onClose={() => setMenuOpen(false)}
          />
        </>
      )}

      <main className="ch-main">
        {/* Confirmación visible de que el enlace de referido se detectó. Sin
            esto, el cliente invitado no tiene forma de saber que su registro
            va a acreditarle puntos a quien lo invitó. */}
        {referrer && !currentUser && showChrome && (
          <div style={{ marginTop: 14, background: "rgba(212,175,106,0.10)", border: "1px solid var(--gold-dim)", borderRadius: 12, padding: "11px 14px", display: "flex", gap: 10, alignItems: "flex-start" }}>
            <Users size={16} color="var(--gold)" style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12.5, lineHeight: 1.45 }}>
              Te invitó <strong>{referrer.name}</strong>. Crea tu cuenta para empezar con {formatPoints(REFERRAL_POINTS_REFERRED)} puntos de bienvenida en tu primera compra.
            </div>
          </div>
        )}
        {view === "landing" && (
          <Landing
            onNav={(v) => (PROTECTED.includes(v) ? requireAuth(v) : navigate(v))}
            merchandisingPicks={merchandisingPicks}
            onGoToModel={(id) => { setCatalogTab(id); navigate("catalog"); }}
          />
        )}
        {(view === "login" || view === "register") && authIntent === "checkout" && (
          <div className="ch-card" style={{ marginTop: 14, fontSize: 13, lineHeight: 1.5, color: "var(--text-dim)" }}>
            🛒 Tu pedido te está esperando. Inicia sesión o crea tu cuenta para terminarlo: así ganas puntos
            con cada compra y puedes darle seguimiento a tu pedido.
          </div>
        )}
        {view === "login" && (
          <LoginView
            onAuthLogin={handleAuthLogin}
            onGoRegister={() => navigate("register")}
            onCancel={() => { setAuthIntent(null); navigate("landing"); }}
          />
        )}
        {view === "register" && (
          <RegisterView referrerName={referrer?.name || null} onRegister={handleRegister} onCancel={() => navigate("login")} />
        )}
        {view === "onboarding" && (
          <OnboardingView onFinish={() => { setHistory([]); navigate("dashboard"); }} />
        )}
        {view === "dashboard" && currentUser && (
          <Dashboard
            customer={currentUser}
            transactions={myTransactions}
            wallet={myWallet}
            merchandisingPicks={merchandisingPicks}
            onGoToModel={(id) => { setCatalogTab(id); navigate("catalog"); }}
            onNav={(v) => navigate(v)}
          />
        )}
        {view === "rewards" && (
          <RewardsView
            balance={currentUser?.pointsBalance ?? null}
            redemptions={myRedemptions}
            onOpenRedeem={openRedeem}
            onGoMyRewards={() => (currentUser ? navigate("myRewards") : requireAuth("myRewards"))}
          />
        )}
        {view === "promotions" && (
          <PromotionsView onGoToModel={(id) => { setCatalogTab(id); navigate("catalog"); }} />
        )}
        {view === "catalog" && (
          <CatalogView
            activeModelId={catalogTab}
            onChangeModel={setCatalogTab}
            cart={cart}
            onChangeQty={changeCartQtyWithToast}
            stockLevels={stockLevels}
          />
        )}
        {view === "productDetail" && (
          <ProductDetailView
            product={PRODUCTS.find((p) => p.id === selectedProductId)}
            onBack={goBack}
            qty={cart[selectedProductId] || 0}
            onChangeQty={changeCartQty}
            onAdd={(product, qty) => { changeCartQty(product.id, qty); showToast(`${qty} x ${product.name} añadido al pedido`); }}
            stockLevels={stockLevels}
          />
        )}
        {view === "cart" && (
          <CartView
            cartList={cartList}
            pricing={cartPricing}
            onChangeQty={changeCartQty}
            onBack={() => navigate("catalog")}
            onGoToCheckout={() => requireAuth("checkout")}
          />
        )}
        {view === "checkout" && (
          <CheckoutView
            cartList={cartList}
            pricing={cartPricing}
            checkoutInfo={checkoutInfo}
            setCheckoutInfo={setCheckoutInfo}
            creditAvailable={currentUser ? myWallet.available : 0}
            onBack={() => navigate("cart")}
            waLink={waLink}
            buildCartMessage={buildCartMessage}
            onConfirm={confirmCartOrder}
            navigateAfterConfirm={() => navigate(currentUser ? "orderSuccess" : "catalog")}
          />
        )}
        {view === "orderSuccess" && lastOrder && (
          <OrderSuccessView order={lastOrder} onDone={() => navigate(lastOrder.guest ? "catalog" : "orders")} />
        )}
        {view === "orders" && currentUser && (
          <OrdersView orders={myOrders} transactions={myTransactions} onGoHistory={() => navigate("pointsHistory")} onRetrySync={retryOrderSync} />
        )}
        {view === "referrals" && currentUser && myReferralStats && (
          <ReferralsView
            customer={currentUser}
            stats={myReferralStats}
            onShared={() => setReferrals((r) => ({ ...r, [currentUser.id]: { invited: (r[currentUser.id]?.invited || 0) + 1 } }))}
            onCopy={() => showToast("Enlace copiado.")}
          />
        )}
        {view === "myRewards" && currentUser && (
          <MyRewardsView
            redemptions={myRedemptions}
            wallet={myWallet}
            onGoCatalog={() => navigate("catalog")}
            onGoRewards={() => navigate("rewards")}
          />
        )}
        {view === "profile" && currentUser && (
          <ProfileView customer={currentUser} onSave={(patch) => {
            setCustomers((cs) => cs.map((c) => c.id === currentUser.id ? { ...c, ...patch } : c));
            showToast("Perfil actualizado.");
          }} onLogout={handleLogout} />
        )}
        {view === "pointsHistory" && currentUser && (
          <PointsHistoryView
            customer={currentUser}
            transactions={filteredTx}
            filter={pointsFilter}
            setFilter={setPointsFilter}
          />
        )}
        {view === "adminGate" && (
          <AdminGateView onSuccess={() => { grantAdminAccess(); navigate("admin"); }} onCancel={() => navigate("landing")} />
        )}
        {view === "admin" && (
          adminAuthed ? (
            <AdminView
              customers={customers}
              orders={orders}
              stockLevels={stockLevels}
              onConfirmOrder={confirmOrder}
              onCancelOrder={cancelOrder}
              onUpdateOrderItemQty={updateOrderItemQty}
              onRegisterManualSale={registerManualSale}
              onSetStock={setProductStock}
              catalogVersion={catalogVersion}
              onAddModel={addModel}
              onUpdateModel={updateModel}
              onDeleteModel={deleteModel}
              onAddFlavor={addFlavor}
              onDeleteFlavor={deleteFlavor}
              onExit={revokeAdminAccess}
              onRefreshOrders={() => refreshOrdersFromSupabase()}
              soundOn={adminSoundOn}
              onToggleSound={toggleAdminSound}
              ordersLoading={ordersLoading}
              rewardsToDeliver={rewardsToDeliver}
              onMarkRewardDelivered={markRewardDelivered}
            />
          ) : (
            // Alguien llegó a la vista "admin" sin haber pasado el código —
            // por ejemplo, con un enlace guardado de antes. Se le manda
            // directo a la puerta, nunca se le muestra el panel de reojo.
            <AdminGateView onSuccess={() => { grantAdminAccess(); navigate("admin"); }} onCancel={() => navigate("landing")} />
          )
        )}
        {(PROTECTED.includes(view) && !currentUser && view !== "login") && (
          <LockedState onLogin={() => requireAuth(view)} />
        )}
      </main>

      {["catalog", "productDetail"].includes(view) && cartCount > 0 && (
        <CartBar count={cartCount} total={cartPricing.total} onView={() => navigate("cart")} />
      )}

      {showBottomNav && (
        <BottomNav
          view={view}
          onNav={(v) => (PROTECTED.includes(v) ? requireAuth(v) : navigate(v))}
        />
      )}

      {redeemModal && (
        <RedeemModal
          reward={REWARDS.find((r) => r.id === redeemModal.rewardId)}
          balance={currentUser?.pointsBalance ?? 0}
          step={redeemModal.step}
          code={redeemModal.code}
          onCancel={() => setRedeemModal(null)}
          onConfirm={confirmRedeem}
          onClose={() => { setRedeemModal(null); navigate("rewards"); }}
          onGoMyRewards={() => { setRedeemModal(null); navigate("myRewards"); }}
        />
      )}

      {toast && <div className="ch-toast">{toast}</div>}
      </>
      )}
    </div>
  );
}

/* ============================================================================
   ESTILOS
============================================================================ */
function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap');

      .ch-root {
        --bg: #0E1210;
        --surface: #161B18;
        --surface-2: #1D2420;
        --border: #2B332D;
        --text: #F3F1EA;
        --text-dim: #9BA79E;
        --text-faint: #67716A;
        --gold: #D4AF6A;
        --gold-dim: #8A7346;
        --green: #7FB88A;
        --rust: #C4785F;
        --radius-s: 10px;
        --radius-m: 16px;
        --radius-l: 22px;
        font-family: 'Inter', -apple-system, sans-serif;
        background: var(--bg);
        color: var(--text);
        min-height: 100vh;
        max-width: 480px;
        margin: 0 auto;
        position: relative;
        padding-bottom: 84px;
        box-sizing: border-box;
      }
      .ch-root * { box-sizing: border-box; }
      .ch-serif { font-family: 'Fraunces', serif; }
      .ch-main { padding: 0 18px; }
      .ch-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 8px;
        border-radius: 999px; border: none; cursor: pointer;
        font-family: 'Inter', sans-serif; font-weight: 600; font-size: 14.5px;
        padding: 13px 22px; transition: transform .12s ease, opacity .12s ease;
        text-decoration: none;
      }
      .ch-btn:active { transform: scale(0.97); }
      .ch-btn-primary { background: var(--gold); color: #14150F; }
      .ch-btn-primary:hover { opacity: 0.92; }
      .ch-btn-secondary { background: var(--surface-2); color: var(--text); border: 1px solid var(--border); }
      .ch-btn-ghost { background: transparent; color: var(--text-dim); border: 1px solid var(--border); }
      .ch-btn-block { width: 100%; }
      .ch-btn:disabled { opacity: 0.4; cursor: not-allowed; }

      .ch-card {
        background: var(--surface); border: 1px solid var(--border);
        border-radius: var(--radius-m); padding: 18px;
      }

      .ch-header {
        position: sticky; top: 0; z-index: 20; background: rgba(14,18,16,0.92);
        backdrop-filter: blur(10px); border-bottom: 1px solid var(--border);
        padding: 14px 18px; display: flex; align-items: center; justify-content: space-between;
      }
      .ch-logo { display: flex; align-items: center; gap: 9px; }
      .ch-logo-mark {
        width: 30px; height: 30px; border-radius: 8px; background: var(--gold);
        display: flex; align-items: center; justify-content: center; color: #14150F; font-weight: 700; font-size: 14px;
      }
      .ch-logo-name { font-family: 'Fraunces', serif; font-size: 17px; letter-spacing: 0.2px; }
      .ch-greet { font-size: 12.5px; color: var(--text-dim); }

      .ch-bottom-nav {
        position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
        width: 100%; max-width: 480px; background: rgba(22,27,24,0.96); backdrop-filter: blur(10px);
        border-top: 1px solid var(--border); display: flex; z-index: 30;
        padding: 8px 6px calc(8px + env(safe-area-inset-bottom));
      }
      .ch-bottom-item {
        flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
        background: none; border: none; color: var(--text-faint); font-size: 9.5px;
        font-family: 'Inter', sans-serif; cursor: pointer; padding: 4px 2px;
      }
      .ch-bottom-item.active { color: var(--gold); }

      .ch-hero-points {
        background: linear-gradient(165deg, var(--surface-2), var(--surface));
        border: 1px solid var(--border); border-radius: var(--radius-l);
        padding: 26px 22px; margin-top: 18px;
      }
      .ch-points-num { font-family: 'Fraunces', serif; font-size: 48px; line-height: 1; font-weight: 500; letter-spacing: -0.5px; }
      .ch-progress-track { height: 8px; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; margin: 14px 0 10px; }
      .ch-progress-fill { height: 100%; background: var(--gold); border-radius: 999px; transition: width .5s ease; }

      .ch-quick-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 18px; }
      .ch-quick-btn {
        background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-m);
        padding: 16px 14px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start;
        cursor: pointer; color: var(--text); font-family: 'Inter'; font-size: 13.5px; font-weight: 600;
      }

      .ch-section-title { font-family: 'Fraunces', serif; font-size: 20px; margin: 30px 0 4px; }
      .ch-section-sub { color: var(--text-dim); font-size: 13.5px; margin-bottom: 16px; }

      .ch-promo-card {
        background: linear-gradient(135deg, #2A2115, var(--surface));
        border: 1px solid var(--gold-dim); border-radius: var(--radius-m); padding: 18px; margin-top: 16px;
      }
      .ch-eyebrow { color: var(--gold); font-size: 11.5px; font-weight: 600; letter-spacing: 0.3px; margin-bottom: 6px; }

      .ch-activity-row { display: flex; align-items: center; gap: 12px; padding: 13px 0; border-bottom: 1px solid var(--border); }
      .ch-activity-row:last-child { border-bottom: none; }
      .ch-activity-icon { width: 34px; height: 34px; border-radius: 999px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .ch-activity-amt { font-family: 'Fraunces', serif; font-size: 15.5px; margin-left: auto; }

      .ch-reward-card { display: flex; gap: 14px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-m); background: var(--surface); margin-bottom: 12px; }
      .ch-reward-art { width: 56px; height: 56px; border-radius: var(--radius-s); background: var(--surface-2); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .ch-tag { font-size: 11px; padding: 3px 9px; border-radius: 999px; font-weight: 600; display: inline-block; }
      .ch-tag-available { background: rgba(127,184,138,0.15); color: var(--green); }
      .ch-tag-almost { background: rgba(212,175,106,0.15); color: var(--gold); }
      .ch-tag-redeemed { background: var(--surface-2); color: var(--text-dim); }
      .ch-tag-unavailable { background: var(--surface-2); color: var(--text-faint); }

      .ch-product-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
      .ch-product-card { border: 1px solid var(--border); border-radius: var(--radius-m); background: var(--surface); overflow: hidden; cursor: pointer; text-align: left; }
      .ch-product-art { height: 92px; background: var(--surface-2); display: flex; align-items: center; justify-content: center; }

      .ch-model-reference {
        height: 240px; border-radius: var(--radius-m); overflow: hidden; background: var(--surface-2);
        display: flex; align-items: center; justify-content: center; margin-top: 14px;
      }
      .ch-model-reference img { width: 100%; height: 100%; object-fit: contain; display: block; }
      .ch-model-reference-placeholder {
        display: flex; flex-direction: column; align-items: center; gap: 6px;
        color: var(--text-faint); font-size: 11.5px;
      }
      .ch-flavor-list {
        border: 1px solid var(--border); border-radius: var(--radius-m); background: var(--surface);
        overflow: hidden; margin-top: 10px;
      }
      .ch-flavor-row {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        padding: 12px 14px; border-bottom: 1px solid var(--border);
      }
      .ch-flavor-row:last-child { border-bottom: none; }

      .ch-promo-model-card {
        display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 14px;
        border: 1px solid var(--border); border-radius: var(--radius-m); background: var(--surface);
        cursor: pointer; text-align: left; font-family: inherit; color: inherit;
      }
      .ch-product-body { padding: 12px; }

      .ch-model-tabs { display: flex; gap: 8px; overflow-x: auto; margin-top: 16px; padding-bottom: 4px; -webkit-overflow-scrolling: touch; }
      .ch-model-tabs::-webkit-scrollbar { display: none; }
      .ch-model-tabs-wrap { position: relative; }
      .ch-model-tabs-arrow {
        display: none; position: absolute; top: 50%; transform: translateY(-50%);
        width: 30px; height: 30px; border-radius: 999px; border: 1px solid var(--border);
        background: var(--surface); color: var(--text-dim); align-items: center; justify-content: center;
        cursor: pointer; z-index: 2; box-shadow: 0 2px 6px rgba(0,0,0,0.25);
      }
      .ch-model-tabs-arrow:hover { background: var(--gold); color: #14150F; border-color: var(--gold-dim); }
      .ch-model-tabs-arrow-left { left: -4px; }
      .ch-model-tabs-arrow-right { right: -4px; }
      /* Solo en pantallas con mouse (desktop): en touch (celular/tablet) ya se
         desliza con el dedo, así que las flechas solo estorbarían. */
      @media (hover: hover) and (pointer: fine) {
        .ch-model-tabs-wrap:hover .ch-model-tabs-arrow { display: flex; }
      }
      .ch-model-tab {
        flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
        padding: 9px 14px; border-radius: 999px; border: 1px solid var(--border);
        background: var(--surface); color: var(--text-dim); font-family: 'Inter', sans-serif;
        font-size: 12.5px; font-weight: 600; white-space: nowrap; cursor: pointer;
      }
      .ch-model-tab-active { background: var(--gold); color: #14150F; border-color: var(--gold-dim); }
      .ch-model-tab-badge {
        background: var(--rust); color: #fff; border-radius: 999px; font-size: 10px;
        min-width: 17px; height: 17px; padding: 0 4px; display: flex; align-items: center; justify-content: center;
      }

      .ch-input-group { margin-bottom: 14px; }
      .ch-label { font-size: 13px; color: var(--text-dim); margin-bottom: 6px; display: block; }
      .ch-input {
        width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-s);
        padding: 13px 14px; color: var(--text); font-size: 14.5px; font-family: 'Inter';
      }
      .ch-input:focus { outline: 2px solid var(--gold); outline-offset: 1px; border-color: transparent; }
      .ch-textarea { resize: vertical; min-height: 76px; font-family: 'Inter'; line-height: 1.5; }

      .ch-pay-option {
        display: flex; align-items: center; gap: 12px; padding: 13px 14px; margin-bottom: 10px;
        border: 1px solid var(--border); border-radius: var(--radius-s); background: var(--surface); cursor: pointer;
      }
      .ch-pay-option-active { border-color: var(--gold); background: rgba(197,161,90,0.08); }
      .ch-pay-option-icon {
        width: 36px; height: 36px; border-radius: 999px; background: var(--surface-2);
        display: flex; align-items: center; justify-content: center; flex: 0 0 auto; color: var(--gold);
      }
      .ch-pay-radio {
        width: 18px; height: 18px; border-radius: 999px; border: 1.5px solid var(--border); flex: 0 0 auto; background: transparent;
      }
      .ch-pay-radio-active { border-color: var(--gold); background: var(--gold); box-shadow: inset 0 0 0 3px var(--surface); }

      .ch-agegate {
        min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; justify-content: center;
        align-items: center; text-align: center; padding: 32px 24px; box-sizing: border-box;
      }

      .ch-modal-backdrop { position: fixed; inset: 0; background: rgba(6,8,7,0.72); display: flex; align-items: flex-end; justify-content: center; z-index: 60; }
      .ch-modal { width: 100%; max-width: 480px; background: var(--surface); border: 1px solid var(--border); border-radius: 22px 22px 0 0; padding: 26px 22px calc(26px + env(safe-area-inset-bottom)); animation: ch-slide-up .22s ease; }
      @keyframes ch-slide-up { from { transform: translateY(24px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }

      .ch-toast {
        position: fixed; bottom: 96px; left: 50%; transform: translateX(-50%);
        background: var(--text); color: #14150F; padding: 11px 20px; border-radius: 999px;
        font-size: 13.5px; font-weight: 600; z-index: 80; animation: ch-fade .2s ease;
      }
      @keyframes ch-fade { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }

      .ch-cart-bar {
        position: fixed; bottom: 78px; left: 50%; transform: translateX(-50%);
        width: calc(100% - 36px); max-width: 444px; background: var(--gold); color: #14150F;
        border: none; border-radius: 999px; padding: 13px 16px; display: flex; align-items: center; gap: 10px;
        cursor: pointer; z-index: 40; box-shadow: 0 10px 30px rgba(0,0,0,0.35); font-family: 'Inter';
      }
      .ch-cart-bar-count {
        width: 24px; height: 24px; border-radius: 999px; background: #14150F; color: var(--gold);
        display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0;
      }

      .ch-locked { text-align: center; padding: 64px 20px; }

      /* Menú lateral: vive fuera del <header> (el header tiene backdrop-filter,
         que convierte al header en el bloque contenedor de cualquier hijo
         position:fixed — por eso el panel quedaba recortado a la altura del
         header y los enlaces se veían "flotando" encima de la página).
         Fondo sólido, z-index por encima de la barra inferior y scroll propio. */
      .ch-side-menu { position: fixed; inset: 0; z-index: 90; }
      .ch-side-backdrop { position: absolute; inset: 0; background: rgba(6,8,7,0.78); backdrop-filter: blur(2px); }
      .ch-side-shell { position: absolute; inset: 0; max-width: 480px; margin: 0 auto; pointer-events: none; }
      .ch-side-panel {
        pointer-events: auto;
        position: absolute; top: 0; right: 0; bottom: 0; width: 80%; max-width: 320px;
        background: #161B18; background-color: var(--surface, #161B18);
        border-left: 1px solid var(--border);
        padding: 20px 22px calc(24px + env(safe-area-inset-bottom));
        overflow-y: auto; -webkit-overflow-scrolling: touch;
        box-shadow: -20px 0 44px rgba(0,0,0,0.6);
        animation: ch-side-in .18s ease-out;
      }
      @keyframes ch-side-in { from { transform: translateX(14px); opacity: 0.4; } to { transform: none; opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .ch-side-panel { animation: none; } }
      .ch-side-link { display: flex; align-items: center; gap: 12px; padding: 13px 4px; color: var(--text); font-size: 15px; cursor: pointer; border-bottom: 1px solid var(--border); background: none; border-top: none; border-left: none; border-right: none; width: 100%; text-align: left; }
      .ch-side-link:hover { color: var(--gold); }

      a.ch-link-plain { color: var(--text); text-decoration: none; }

      @media (min-width: 640px) and (max-width: 899px) {
        .ch-root { max-width: 480px; box-shadow: 0 0 60px rgba(0,0,0,0.4); }
      }

      /* ------------------------------------------------------------------
         MODO ESCRITORIO (>= 900px)
         El teléfono sigue siendo la prioridad (ahí llega la mayoría del
         tráfico) y el HTML de arriba es el mismo: aquí solo se reacomoda.
         La barra inferior se convierte en un panel lateral fijo, el
         contenido usa el ancho extra en más columnas, y los modales /
         hojas inferiores se centran como diálogos en vez de deslizarse
         desde abajo.
      ------------------------------------------------------------------ */
      @media (min-width: 900px) {
        html, body { background: var(--bg, #0E1210); }

        .ch-root {
          max-width: 1180px;
          min-height: 100vh;
          padding-bottom: 40px;
          padding-left: 232px;
          box-shadow: none;
        }

        .ch-main { padding: 0 40px 0 32px; max-width: 900px; }

        .ch-header { padding: 18px 40px 18px 32px; }

        /* Barra inferior -> panel lateral fijo a la izquierda */
        .ch-bottom-nav {
          top: 0; left: 0; bottom: 0; right: auto; transform: none;
          width: 232px; max-width: 232px; height: 100vh;
          flex-direction: column; justify-content: flex-start; align-items: stretch;
          gap: 4px; padding: 92px 14px 24px;
          border-top: none; border-right: 1px solid var(--border);
          background: rgba(22,27,24,0.98);
        }
        .ch-bottom-item {
          flex-direction: row; justify-content: flex-start; gap: 12px;
          font-size: 13.5px; padding: 11px 14px; border-radius: var(--radius-s);
        }
        .ch-bottom-item.active { background: var(--surface-2); }

        /* Menú lateral / carrito / toast: ya no hace falta centrarlos en 480px */
        .ch-side-shell { max-width: 100%; }
        .ch-cart-bar { left: auto; right: 40px; transform: none; bottom: 28px; max-width: 380px; }

        /* Modales como diálogo centrado, no como hoja inferior */
        .ch-modal-backdrop { align-items: center; }
        .ch-modal {
          max-width: 440px; border-radius: var(--radius-l);
          animation: ch-modal-in .18s ease;
        }
        @keyframes ch-modal-in { from { transform: translateY(10px); opacity: 0; } to { transform: none; opacity: 1; } }

        /* Más columnas donde hay espacio de sobra */
        .ch-product-grid { grid-template-columns: repeat(3, 1fr); }
        .ch-quick-grid { grid-template-columns: repeat(4, 1fr); }
      }

      @media (min-width: 1280px) {
        .ch-root { padding-left: 260px; }
        .ch-bottom-nav { width: 260px; max-width: 260px; }
        .ch-main { max-width: 980px; }
        .ch-product-grid { grid-template-columns: repeat(4, 1fr); }
      }
    `}</style>
  );
}

/* ============================================================================
   HEADER + NAV
============================================================================ */
function Header({ currentUser, onNav, onLogin, setMenuOpen, onSecretAdmin }) {
  // Puerta oculta: 5 toques al logo en menos de 2.5s abren el acceso de
  // administrador. Nunca interfiere con el toque normal (que sigue llevando
  // a inicio) — solo se activa si alguien toca deliberadamente varias veces
  // seguidas, cosa que un cliente normal jamás hace por accidente.
  const tapTimes = useRef([]);
  function handleLogoTap() {
    const now = Date.now();
    tapTimes.current = [...tapTimes.current, now].filter((t) => now - t < 2500);
    if (tapTimes.current.length >= 5) {
      tapTimes.current = [];
      onSecretAdmin();
      return;
    }
    onNav(currentUser ? "dashboard" : "landing");
  }

  return (
    <header className="ch-header">
      <button className="ch-logo" style={{ background: "none", border: "none", cursor: "pointer" }} onClick={handleLogoTap}>
        <LogoMark />
        <div style={{ textAlign: "left" }}>
          <div className="ch-logo-name">The King Shop</div>
          {currentUser && <div className="ch-greet">Hola, {currentUser.name}</div>}
        </div>
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {!currentUser && (
          <button className="ch-btn ch-btn-secondary" style={{ padding: "8px 16px", fontSize: 13 }} onClick={onLogin}>
            Iniciar sesión
          </button>
        )}
        <button style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, width: 38, height: 38, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }} onClick={() => setMenuOpen(true)}>
          <Menu size={18} color="var(--text)" />
        </button>
      </div>

    </header>
  );
}

/* El menú va montado como hermano del header (nunca dentro de él) para que su
   position: fixed se mida contra la ventana y no contra la barra superior. */
function SideMenu({ open, currentUser, onNav, onLogout, onClose }) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onEsc = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onEsc); };
  }, [open, onClose]);

  if (!open) return null;
  const go = (v) => { onClose(); onNav(v); };

  return (
    <div className="ch-side-menu" role="dialog" aria-modal="true" aria-label="Menú">
      <div className="ch-side-backdrop" onClick={onClose} />
      <div className="ch-side-shell">
        <div className="ch-side-panel">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <span className="ch-serif" style={{ fontSize: 17 }}>Menú</span>
            <button aria-label="Cerrar menú" style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 9, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }} onClick={onClose}>
              <X size={18} color="var(--text)" />
            </button>
          </div>
          <button className="ch-side-link" onClick={() => go("dashboard")}><Home size={17} /> Inicio</button>
          <button className="ch-side-link" onClick={() => go("promotions")}><Tag size={17} /> Promociones</button>
          <button className="ch-side-link" onClick={() => go("catalog")}><ShoppingBag size={17} /> Catálogo</button>
          <button className="ch-side-link" onClick={() => go("rewards")}><Gift size={17} /> Catálogo de recompensas</button>
          <button className="ch-side-link" onClick={() => go("myRewards")}><Star size={17} /> Mis recompensas</button>
          <button className="ch-side-link" onClick={() => go("pointsHistory")}><Wallet size={17} /> Mis puntos</button>
          <button className="ch-side-link" onClick={() => go("orders")}><Package size={17} /> Mis pedidos</button>
          <button className="ch-side-link" onClick={() => go("referrals")}><Users size={17} /> Referidos</button>
          <button className="ch-side-link" onClick={() => go("profile")}><User size={17} /> Mi perfil</button>
          <a className="ch-side-link ch-link-plain" href={waLink("Hola, quiero hacer un pedido.")} target="_blank" rel="noopener noreferrer" onClick={onClose}><MessageCircle size={17} /> WhatsApp</a>
          {currentUser && (
            <button className="ch-side-link" style={{ color: "var(--rust)" }} onClick={() => { onClose(); onLogout(); }}><LogOut size={17} /> Cerrar sesión</button>
          )}
        </div>
      </div>
    </div>
  );
}

function BottomNav({ view, onNav }) {
  const items = [
    { id: "dashboard", label: "Inicio", icon: Home },
    { id: "promotions", label: "Promos", icon: Tag },
    { id: "catalog", label: "Catálogo", icon: ShoppingBag },
    { id: "rewards", label: "Recompensas", icon: Gift },
    { id: "pointsHistory", label: "Mis puntos", icon: Wallet },
    { id: "profile", label: "Perfil", icon: User },
  ];
  return (
    <nav className="ch-bottom-nav">
      {items.map((it) => {
        const Icon = it.icon;
        const active = view === it.id || (it.id === "dashboard" && view === "landing");
        return (
          <button key={it.id} className={"ch-bottom-item" + (active ? " active" : "")} onClick={() => onNav(it.id)}>
            <Icon size={18} strokeWidth={active ? 2.2 : 1.7} />
            {it.label}
          </button>
        );
      })}
    </nav>
  );
}

/* ============================================================================
   VERIFICACIÓN DE EDAD (primera pantalla, obligatoria antes de todo)
============================================================================ */
function AgeGate({ denied, onConfirm }) {
  if (denied) {
    return (
      <div className="ch-agegate">
        <LogoMark style={{ width: 92, height: 92, fontSize: 30, margin: "0 auto 18px" }} />
        <h1 className="ch-serif" style={{ fontSize: 22, margin: "0 0 10px" }}>Acceso restringido</h1>
        <p style={{ color: "var(--text-dim)", fontSize: 14, maxWidth: 300, margin: "0 auto" }}>
          Este sitio ofrece productos exclusivos para personas mayores de edad. No es posible continuar.
        </p>
      </div>
    );
  }
  return (
    <div className="ch-agegate">
      <LogoMark style={{ width: 92, height: 92, fontSize: 30, margin: "0 auto 18px" }} />
      <h1 className="ch-serif" style={{ fontSize: 24, margin: "0 0 10px" }}>¿Eres mayor de edad?</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 14, maxWidth: 300, margin: "0 auto 26px" }}>
        Este sitio contiene productos de vapeo destinados únicamente a personas mayores de edad. Confirma tu edad para continuar.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 280, margin: "0 auto" }}>
        <button className="ch-btn ch-btn-primary ch-btn-block" onClick={() => onConfirm(true)}>Sí, soy mayor de edad</button>
        <button className="ch-btn ch-btn-ghost ch-btn-block" onClick={() => onConfirm(false)}>No</button>
      </div>
      <p style={{ color: "var(--text-faint)", fontSize: 11, maxWidth: 280, margin: "22px auto 0" }}>
        Al continuar declaras bajo tu responsabilidad que cuentas con la mayoría de edad legal en tu país de residencia.
      </p>
    </div>
  );
}

/* ============================================================================
   LANDING (pública, para tráfico NFC / visitantes sin sesión)
============================================================================ */
/* Tira horizontal de sugerencias — la misma en Landing y Dashboard, para que
   una persona invitada y una ya logueada vean exactamente lo mismo cerca del
   inicio. onSelect manda al catálogo directo al sabor elegido. */
function MerchandisingRow({ picks, onSelect }) {
  if (picks.length === 0) return null;
  return (
    <div style={{ marginTop: 22 }}>
      {/* Etiqueta pedida por el negocio: "Lo más vendido". El criterio real de
          orden sigue siendo el de mayor stock restante (lo que menos rota),
          igual que la lógica de caducidad próxima primero — el nombre visible
          es una decisión de marketing del dueño, el orden interno no cambió. */}
      <h2 className="ch-section-title" style={{ marginBottom: 8 }}>Lo más vendido</h2>
      <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4, marginLeft: -18, marginRight: -18, paddingLeft: 18, paddingRight: 18 }}>
        {picks.map(({ product, remaining, model }) => (
          <button
            key={product.id}
            onClick={() => onSelect(model?.id)}
            style={{
              flexShrink: 0, width: 132, textAlign: "left", background: "var(--surface)",
              border: "1px solid var(--border)", borderRadius: 14, padding: 12, cursor: "pointer",
              fontFamily: "'Inter', sans-serif", color: "var(--text)",
            }}
          >
            <div style={{ fontSize: 24 }}>{model?.icon || "💨"}</div>
            <div style={{ fontWeight: 600, fontSize: 12.5, marginTop: 8, lineHeight: 1.3 }}>{model?.name}</div>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>{product.name}</div>
            <div style={{ fontSize: 12.5, color: "var(--gold)", marginTop: 6, fontWeight: 600 }}>{formatMoney(product.price)}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function Landing({ onNav, merchandisingPicks, onGoToModel }) {
  return (
    <div style={{ paddingBottom: 20 }}>
      <div style={{ marginTop: 30, textAlign: "center" }}>
        <LogoMark style={{ width: 92, height: 92, fontSize: 30, margin: "0 auto 18px" }} />
        {/* El titular es la entrega el mismo día: es la ventaja real frente a
            proveedores que tardan 1 o 2 días, así que va primero y en grande.
            "Todo lo que buscas..." pasa a ser el subtítulo de apoyo. */}
        <h1 className="ch-serif" style={{ fontSize: 30, lineHeight: 1.15, margin: "0 0 10px" }}>
          Haz tu pedido y recíbelo el mismo día.
        </h1>
        <p style={{ color: "var(--text-dim)", fontSize: 14.5, maxWidth: 320, margin: "0 auto" }}>
          Todo lo que buscas, en un solo lugar.
        </p>
        <div style={{
          display: "inline-flex", alignItems: "center", gap: 6, marginTop: 14,
          background: "rgba(212,175,106,0.12)", border: "1px solid var(--gold-dim)",
          borderRadius: 999, padding: "6px 14px", fontSize: 12, color: "var(--gold)", fontWeight: 600,
        }}>
          <Star size={13} /> Entregamos el mismo día — otros tardan 1 o 2 días
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 26 }}>
        <a className="ch-btn ch-btn-primary ch-btn-block ch-link-plain" href={waLink("Hola, quiero hacer un pedido.")} target="_blank" rel="noopener noreferrer">Hacer pedido</a>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="ch-btn ch-btn-secondary" style={{ flex: 1 }} onClick={() => onNav("rewards")}>Ver recompensas</button>
          <button className="ch-btn ch-btn-secondary" style={{ flex: 1 }} onClick={() => onNav("catalog")}>Ver catálogo</button>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="ch-btn ch-btn-ghost" style={{ flex: 1 }} onClick={() => onNav("login")}>Iniciar sesión</button>
          <button className="ch-btn ch-btn-ghost" style={{ flex: 1 }} onClick={() => onNav("register")}>Crear cuenta</button>
        </div>
      </div>

      <h2 className="ch-section-title" style={{ marginTop: 30 }}>Cómo funciona</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}>
        {[
          ["Compra", "Cada pedido suma puntos a tu cuenta."],
          ["Acumula", "Consulta siempre cuánto tienes y qué te falta."],
          ["Canjea", "Usa tus puntos por recompensas reales."],
        ].map(([t, d]) => (
          <div key={t} className="ch-card" style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
            <Star size={18} color="var(--gold)" style={{ marginTop: 2, flexShrink: 0 }} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14.5 }}>{t}</div>
              <div style={{ color: "var(--text-dim)", fontSize: 13.5, marginTop: 2 }}>{d}</div>
            </div>
          </div>
        ))}
      </div>

      <MerchandisingRow picks={merchandisingPicks} onSelect={onGoToModel} />

      <h2 className="ch-section-title" style={{ marginTop: 26 }}>Promo 2x por modelo</h2>
      <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: -6, marginBottom: 10 }}>
        Toca un modelo para ir directo a su catálogo y aprovechar la promo.
      </p>
      <PromoByModelList onGoToModel={onGoToModel} />

      <div style={{ marginTop: 30, textAlign: "center" }}>
        <a className="ch-btn ch-btn-secondary" href={waLink("Hola, quiero hacer un pedido.")} target="_blank" rel="noopener noreferrer">
          <MessageCircle size={16} /> Escríbenos por WhatsApp
        </a>
      </div>
    </div>
  );
}


/* ============================================================================
   LOGIN / REGISTER / ONBOARDING
============================================================================ */
function LoginView({ onAuthLogin, onGoRegister, onCancel }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!email || !password) { setError("Ingresa tu correo y tu contraseña."); return; }
    setError("");
    setLoading(true);
    const result = await onAuthLogin({ email, password });
    setLoading(false);
    if (result?.error) setError(result.error);
  }

  return (
    <div style={{ paddingTop: 26 }}>
      <button onClick={onCancel} style={{ background: "none", border: "none", color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: 0, marginBottom: 18 }}>
        <ArrowLeft size={16} /> Volver
      </button>
      <h1 className="ch-serif" style={{ fontSize: 26 }}>Bienvenido de nuevo</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13.5, marginTop: 4, marginBottom: 22 }}>
        Inicia sesión con tu correo y contraseña.
      </p>

      <div onKeyDown={(e) => { if (e.key === "Enter") submit(e); }}>
        <div className="ch-input-group">
          <label className="ch-label">Correo</label>
          <input className="ch-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="tucorreo@ejemplo.com" />
        </div>
        <div className="ch-input-group">
          <label className="ch-label">Contraseña</label>
          <div style={{ position: "relative" }}>
            <input className="ch-input" type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            <button type="button" onClick={() => setShowPw((s) => !s)} style={{ position: "absolute", right: 12, top: 12, background: "none", border: "none", cursor: "pointer" }}>
              {showPw ? <EyeOff size={17} color="var(--text-dim)" /> : <Eye size={17} color="var(--text-dim)" />}
            </button>
          </div>
        </div>
        {error && <div style={{ color: "var(--rust)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <button className="ch-btn ch-btn-primary ch-btn-block" type="button" onClick={submit} disabled={loading}>
          {loading ? "Entrando…" : "Iniciar sesión"}
        </button>
      </div>

      <div style={{ textAlign: "center", marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
        <button style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: 13, cursor: "pointer" }}>¿Olvidaste tu contraseña?</button>
        <button onClick={onGoRegister} style={{ background: "none", border: "none", color: "var(--gold)", fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}>Crear cuenta</button>
      </div>
    </div>
  );
}

function RegisterView({ referrerName, onRegister, onCancel }) {
  const [form, setForm] = useState({ name: "", phone: "", email: "", password: "", confirm: "" });
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Sin <form onSubmit>: en contextos donde el iframe va en sandbox el navegador
  // bloquea el envío del formulario y el botón "no hace nada". Con un botón
  // normal + onClick el registro siempre corre.
  async function submit(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!form.name || !form.phone || !form.email || !form.password) { setError("Completa todos los campos."); return; }
    if (form.password !== form.confirm) { setError("Las contraseñas no coinciden."); return; }
    if (form.password.length < 6) { setError("La contraseña debe tener al menos 6 caracteres."); return; }
    if (!accepted) { setError("Acepta los términos y condiciones para continuar."); return; }
    setError("");
    setLoading(true);
    const result = await onRegister(form);
    setLoading(false);
    if (result?.error) setError(result.error);
  }

  function onKeyDown(e) {
    if (e.key === "Enter") submit(e);
  }

  return (
    <div style={{ paddingTop: 26 }}>
      <button onClick={onCancel} style={{ background: "none", border: "none", color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: 0, marginBottom: 18 }}>
        <ArrowLeft size={16} /> Volver
      </button>
      <h1 className="ch-serif" style={{ fontSize: 26 }}>Crear mi cuenta</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13.5, marginTop: 4, marginBottom: referrerName ? 14 : 22 }}>Regístrate en menos de un minuto.</p>
      {referrerName && (
        <div style={{ background: "rgba(212,175,106,0.10)", border: "1px solid var(--gold-dim)", borderRadius: 12, padding: "11px 14px", marginBottom: 20, fontSize: 12.5, lineHeight: 1.45 }}>
          Te invitó <strong>{referrerName}</strong>. Al crear tu cuenta queda registrada la invitación.
        </div>
      )}

      <div onKeyDown={onKeyDown}>
        <div className="ch-input-group"><label className="ch-label">Nombre</label><input className="ch-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="ch-input-group">
          <label className="ch-label">Teléfono</label>
          <input className="ch-input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div className="ch-input-group"><label className="ch-label">Email</label><input className="ch-input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div className="ch-input-group"><label className="ch-label">Contraseña</label><input className="ch-input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
        <div className="ch-input-group"><label className="ch-label">Confirmar contraseña</label><input className="ch-input" type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} /></div>
        <label style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 12.5, color: "var(--text-dim)", marginBottom: 18 }}>
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} style={{ marginTop: 2 }} />
          Acepto términos y condiciones.
        </label>
        {error && <div style={{ color: "var(--rust)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <button className="ch-btn ch-btn-primary ch-btn-block" type="button" onClick={submit} disabled={loading}>
          {loading ? "Creando cuenta…" : "Crear cuenta"}
        </button>
      </div>
    </div>
  );
}

function OnboardingView({ onFinish }) {
  const steps = [
    { title: "Acumula puntos", body: "Cada compra puede ayudarte a acercarte a nuevas recompensas." },
    { title: "Consulta tu progreso", body: "Siempre sabrás cuánto tienes y cuánto te falta." },
    { title: "Canjea beneficios", body: "Utiliza tus puntos cuando alcances una recompensa." },
  ];
  const [step, setStep] = useState(0);
  const last = step === steps.length - 1;
  return (
    <div style={{ minHeight: "80vh", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 4px" }}>
      <div className="ch-eyebrow" style={{ textAlign: "center" }}>¡Bienvenido! Tu cuenta está lista.</div>
      <h1 className="ch-serif" style={{ fontSize: 28, textAlign: "center", margin: "14px 0 8px" }}>{steps[step].title}</h1>
      <p style={{ color: "var(--text-dim)", textAlign: "center", fontSize: 14.5, maxWidth: 300, margin: "0 auto" }}>{steps[step].body}</p>

      <div style={{ display: "flex", justifyContent: "center", gap: 6, marginTop: 28 }}>
        {steps.map((_, i) => (
          <div key={i} style={{ width: i === step ? 22 : 7, height: 7, borderRadius: 999, background: i === step ? "var(--gold)" : "var(--border)", transition: "all .2s" }} />
        ))}
      </div>

      <button className="ch-btn ch-btn-primary ch-btn-block" style={{ marginTop: 34 }} onClick={() => (last ? onFinish() : setStep((s) => s + 1))}>
        {last ? "Comenzar" : "Siguiente"}
      </button>
    </div>
  );
}

/* ============================================================================
   DASHBOARD
============================================================================ */
function Dashboard({ customer, transactions, wallet, merchandisingPicks, onGoToModel, onNav }) {
  const pct = Math.min(100, Math.round((customer.pointsBalance / NEXT_REWARD_TARGET) * 100));
  const remaining = Math.max(0, NEXT_REWARD_TARGET - customer.pointsBalance);
  // Antes tomaba PROMOTIONS[0] sin importar su estado, así que una promo
  // apagada (active: false) igual se mostraba en el dashboard. Ahora toma
  // la primera que de verdad esté vigente.
  const promo = PROMOTIONS.find((p) => p.active);
  // La meta que se muestra es la recompensa activa más barata, así el hero
  // siempre apunta a lo que de verdad está más cerca.
  const nextReward = REWARDS.filter((r) => r.active).sort((a, b) => a.pointsCost - b.pointsCost)[0];

  return (
    <div style={{ paddingTop: 14 }}>
      <div className="ch-hero-points">
        <div style={{ fontSize: 13, color: "var(--text-dim)" }}>Tu saldo</div>
        <div className="ch-points-num">{formatPoints(customer.pointsBalance)} <span style={{ fontSize: 18, color: "var(--text-dim)", fontFamily: "Inter" }}>puntos</span></div>

        {remaining > 0 ? (
          <>
            <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 14 }}>
              Te faltan <strong style={{ color: "var(--text)" }}>{formatPoints(remaining)}</strong> puntos para tu próxima recompensa.
            </div>
            <div className="ch-progress-track"><div className="ch-progress-fill" style={{ width: pct + "%" }} /></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-faint)" }}>
              <span>{formatPoints(customer.pointsBalance)} / {formatPoints(NEXT_REWARD_TARGET)} puntos</span>
              <span>{pct}%</span>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: "var(--green)", marginTop: 14 }}>Ya tienes puntos suficientes para tu próxima recompensa.</div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
          <div>
            <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>Próxima recompensa</div>
            <div style={{ fontFamily: "Fraunces, serif", fontSize: 16 }}>{nextReward?.name || "Recompensa"}</div>
          </div>
          <button className="ch-btn ch-btn-secondary" style={{ padding: "9px 16px", fontSize: 13 }} onClick={() => onNav("rewards")}>Ver recompensa</button>
        </div>
      </div>

      {wallet?.available > 0 && (
        <button
          onClick={() => onNav("myRewards")}
          style={{ width: "100%", textAlign: "left", marginTop: 14, background: "rgba(212,175,106,0.10)", border: "1px solid var(--gold-dim)", borderRadius: 14, padding: "13px 15px", display: "flex", alignItems: "center", gap: 12, cursor: "pointer", fontFamily: "'Inter', sans-serif", color: "var(--text)" }}
        >
          <div style={{ fontSize: 22 }}>💳</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>Tienes {formatMoney(wallet.available)} de crédito</div>
            <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>Se descuenta al pagar tu próximo pedido</div>
          </div>
          <ChevronRight size={17} color="var(--text-dim)" />
        </button>
      )}

      <MerchandisingRow picks={merchandisingPicks} onSelect={onGoToModel} />

      <div className="ch-quick-grid">
        <a className="ch-quick-btn ch-link-plain" href={waLink("Hola, quiero hacer un pedido.")} target="_blank" rel="noopener noreferrer"><ShoppingBag size={19} color="var(--gold)" />Hacer pedido</a>
        <button className="ch-quick-btn" onClick={() => onNav("rewards")}><Gift size={19} color="var(--gold)" />Ver recompensas</button>
        <button className="ch-quick-btn" onClick={() => onNav("catalog")}><Package size={19} color="var(--gold)" />Ver catálogo</button>
        <button className="ch-quick-btn" onClick={() => onNav("referrals")}><Users size={19} color="var(--gold)" />Invitar a un amigo</button>
      </div>

      {promo && (
        <>
          <h2 className="ch-section-title">Beneficio exclusivo</h2>
          <div className="ch-promo-card">
            <div className="ch-eyebrow">Beneficio exclusivo</div>
            <div style={{ fontFamily: "Fraunces, serif", fontSize: 17, marginBottom: 6 }}>{promo.title}</div>
            <div style={{ color: "var(--text-dim)", fontSize: 13.5, marginBottom: 14 }}>{promo.description}</div>
            <button className="ch-btn ch-btn-secondary" style={{ padding: "9px 16px", fontSize: 13 }} onClick={() => onNav("catalog")}>Ver beneficio</button>
          </div>
        </>
      )}

    </div>
  );
}

function ActivityRow({ t }) {
  const positive = t.amount > 0;
  return (
    <div className="ch-activity-row">
      <div className="ch-activity-icon" style={{ background: positive ? "rgba(127,184,138,0.14)" : "rgba(196,120,95,0.14)" }}>
        {positive ? <TrendingUp size={16} color="var(--green)" /> : <TrendingDown size={16} color="var(--rust)" />}
      </div>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 500 }}>{t.description}</div>
        <div style={{ fontSize: 12, color: "var(--text-faint)" }}>{formatDate(t.createdAt)}</div>
      </div>
      <div className="ch-activity-amt" style={{ color: positive ? "var(--green)" : "var(--rust)" }}>
        {positive ? "+" : ""}{formatPoints(t.amount)}
      </div>
    </div>
  );
}

function EmptyRow({ text }) {
  return <div style={{ textAlign: "center", color: "var(--text-faint)", fontSize: 13.5, padding: "20px 0" }}>{text}</div>;
}

/* ============================================================================
   RECOMPENSAS
============================================================================ */
function RewardsView({ balance, redemptions, onOpenRedeem, onGoMyRewards }) {
  const loggedIn = balance !== null;
  return (
    <div style={{ paddingTop: 20 }}>
      <h1 className="ch-serif" style={{ fontSize: 24 }}>Recompensas</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13.5, marginTop: 4 }}>Usa tus puntos para obtener beneficios.</p>

      {loggedIn ? (
        <div className="ch-card" style={{ marginTop: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 13.5, color: "var(--text-dim)" }}>Mis puntos</span>
          <span className="ch-serif" style={{ fontSize: 20 }}>{formatPoints(balance)}</span>
        </div>
      ) : (
        <div className="ch-card" style={{ marginTop: 16, fontSize: 13, color: "var(--text-dim)" }}>
          Inicia sesión para ver tu progreso personal en cada recompensa.
        </div>
      )}

      <div style={{ marginTop: 20 }}>
        {REWARDS.map((r) => {
          const status = loggedIn ? rewardStatus(r, balance) : (r.active ? "browse" : "unavailable");
          // Cada recompensa se canjea UNA vez por cliente, para siempre — incluido
          // el crédito. Antes, en cuanto se agotaba el saldo del crédito volvía a
          // aparecer como disponible, y con eso alguien podía quedarse canjeando
          // el mismo premio en ciclo en vez de ir por los demás. Ahora, una vez
          // canjeada, queda marcada como tuya aunque el saldo llegue a $0.
          const redeemedEntry = redemptions.find((rd) => rd.rewardId === r.id);
          return (
            <div key={r.id} className="ch-reward-card">
              <div className="ch-reward-art"><ArtIcon kind={r.image} className="" /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14.5 }}>{r.name}</div>
                <div style={{ color: "var(--text-dim)", fontSize: 12.5, margin: "3px 0 8px" }}>{r.description}</div>
                <div style={{ fontSize: 12.5, color: "var(--text-faint)", marginBottom: 8 }}>{formatPoints(r.pointsCost)} puntos</div>
                {typeof r.creditValue === "number" && (
                  <div style={{ fontSize: 11.5, color: "var(--text-dim)", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", marginBottom: 10, lineHeight: 1.5 }}>
                    Cubre hasta el <strong>{Math.round(CREDIT_MAX_PERCENT * 100)}%</strong> del total de cada pedido — nunca lo cubre completo. Lo que no se use se queda en tu cuenta para tu siguiente compra. No aplica al costo de envío.
                  </div>
                )}

                {redeemedEntry && (
                  <>
                    <span className="ch-tag ch-tag-redeemed">
                      {typeof redeemedEntry.creditValue === "number"
                        ? `Ya es tuya · ${formatMoney(redeemedEntry.creditRemaining)} disponibles`
                        : `Canjeada · ${formatDate(redeemedEntry.createdAt)}`}
                    </span>
                    <div style={{ marginTop: 10 }}>
                      <button className="ch-btn ch-btn-secondary" style={{ padding: "8px 16px", fontSize: 13 }} onClick={onGoMyRewards}>
                        Ver en Mis recompensas
                      </button>
                    </div>
                  </>
                )}
                {!redeemedEntry && status === "available" && (
                  <>
                    <span className="ch-tag ch-tag-available" style={{ marginRight: 8 }}>Puedes canjear esta recompensa</span>
                    <div style={{ marginTop: 10 }}>
                      <button className="ch-btn ch-btn-primary" style={{ padding: "8px 16px", fontSize: 13 }} onClick={() => onOpenRedeem(r)}>Canjear</button>
                    </div>
                  </>
                )}
                {!redeemedEntry && status === "almost" && (
                  <>
                    <span className="ch-tag ch-tag-almost">Te faltan {formatPoints(r.pointsCost - balance)} puntos</span>
                    <div style={{ marginTop: 10 }}>
                      <button className="ch-btn ch-btn-secondary" style={{ padding: "8px 16px", fontSize: 13 }} onClick={() => onOpenRedeem(r)}>Ver progreso</button>
                    </div>
                  </>
                )}
                {!redeemedEntry && status === "unavailable" && (
                  <span className="ch-tag ch-tag-unavailable">No disponible temporalmente</span>
                )}
                {!redeemedEntry && status === "browse" && (
                  <div style={{ marginTop: 10 }}>
                    <button className="ch-btn ch-btn-secondary" style={{ padding: "8px 16px", fontSize: 13 }} onClick={() => onOpenRedeem(r)}>Iniciar sesión para canjear</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================================
   MIS RECOMPENSAS — lo que el cliente YA tiene en la mano
   El catálogo (RewardsView) es "a qué puedo aspirar". Esta vista es "qué es
   mío y cómo lo uso". El crédito de tienda aparece arriba con su saldo vivo
   y un botón que lleva directo al catálogo para gastarlo.
============================================================================ */
function MyRewardsView({ redemptions, wallet, onGoCatalog, onGoRewards }) {
  const rewardById = (id) => REWARDS.find((r) => r.id === id);
  const credits = redemptions.filter((r) => typeof r.creditValue === "number");
  const others = redemptions.filter((r) => typeof r.creditValue !== "number");

  return (
    <div style={{ paddingTop: 20 }}>
      <h1 className="ch-serif" style={{ fontSize: 24 }}>Mis recompensas</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13.5, marginTop: 4 }}>
        Lo que ya canjeaste y cómo usarlo.
      </p>

      {wallet.available > 0 && (
        <div className="ch-card" style={{ marginTop: 18, borderColor: "var(--gold-dim)" }}>
          <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Crédito disponible en la tienda</div>
          <div className="ch-serif" style={{ fontSize: 30, color: "var(--gold)", margin: "4px 0 10px" }}>
            {formatMoney(wallet.available)}
          </div>
          <p style={{ fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.5, marginBottom: 14 }}>
            Se descuenta solo al hacer tu pedido: elígelo en la pantalla de pago y el total baja al momento.
            Cubre hasta el {Math.round(CREDIT_MAX_PERCENT * 100)}% del total de cada pedido, no el pedido completo ni el envío;
            lo que no uses se queda disponible.
          </p>
          <button className="ch-btn ch-btn-primary ch-btn-block" onClick={onGoCatalog}>
            Canjear ahora — ir al catálogo
          </button>
        </div>
      )}

      {redemptions.length === 0 ? (
        <div className="ch-card" style={{ marginTop: 18, textAlign: "center", padding: "30px 18px" }}>
          <Gift size={26} color="var(--text-faint)" />
          <div style={{ fontSize: 14, marginTop: 10 }}>Todavía no has canjeado nada</div>
          <p style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: 6, lineHeight: 1.5 }}>
            Cuando canjees una recompensa aparecerá aquí, lista para usarse.
          </p>
          <button className="ch-btn ch-btn-secondary" style={{ marginTop: 14 }} onClick={onGoRewards}>
            Ver recompensas disponibles
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 18 }}>
          {[...credits, ...others].map((rd) => {
            const reward = rewardById(rd.rewardId);
            const isCredit = typeof rd.creditValue === "number";
            const spent = (rd.usedOn || []).reduce((sm, u) => sm + u.amount, 0);
            return (
              <div key={rd.id} className="ch-reward-card">
                <div className="ch-reward-art"><ArtIcon kind={reward?.image} className="" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14.5 }}>{reward?.name || "Recompensa"}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-faint)", margin: "3px 0 8px" }}>
                    Canjeada el {formatDate(rd.createdAt)} · {formatPoints(rd.pointsUsed)} puntos
                  </div>

                  {isCredit ? (
                    rd.creditRemaining > 0 ? (
                      <>
                        <span className="ch-tag ch-tag-available">
                          Disponible: {formatMoney(rd.creditRemaining)}
                        </span>
                        {spent > 0 && (
                          <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 6 }}>
                            Ya usaste {formatMoney(spent)} de esta recompensa.
                          </div>
                        )}
                        <div style={{ marginTop: 10 }}>
                          <button className="ch-btn ch-btn-primary" style={{ padding: "8px 16px", fontSize: 13 }} onClick={onGoCatalog}>
                            Canjear ahora
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="ch-tag ch-tag-redeemed">Crédito usado por completo</span>
                        <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 6 }}>
                          Aplicado en {(rd.usedOn || []).length} pedido{(rd.usedOn || []).length === 1 ? "" : "s"}.
                        </div>
                      </>
                    )
                  ) : (
                    <>
                      <span className="ch-tag ch-tag-almost">{rd.status}</span>
                      <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8 }}>
                        Código: <strong>{rd.code}</strong> — muéstralo por WhatsApp para recibirla.
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RedeemModal({ reward, balance, step, code, onCancel, onConfirm, onClose, onGoMyRewards }) {
  if (!reward) return null;
  const after = balance - reward.pointsCost;
  return (
    <div className="ch-modal-backdrop" onClick={step === "confirm" ? onCancel : undefined}>
      <div className="ch-modal" onClick={(e) => e.stopPropagation()}>
        {step === "confirm" && (
          <>
            <h2 className="ch-serif" style={{ fontSize: 19, marginBottom: 6 }}>¿Quieres canjear {formatPoints(reward.pointsCost)} puntos por esta recompensa?</h2>
            <div style={{ color: "var(--text-dim)", fontSize: 13.5, marginBottom: 18 }}>{reward.name}</div>
            <div className="ch-card" style={{ marginBottom: 20 }}>
              <Row label="Saldo actual" value={`${formatPoints(balance)} puntos`} />
              <Row label="Costo" value={`${formatPoints(reward.pointsCost)} puntos`} />
              <Row label="Saldo después" value={`${formatPoints(Math.max(after, 0))} puntos`} bold />
            </div>
            {typeof reward.creditValue === "number" && (
              <div style={{ fontSize: 12, color: "var(--text-dim)", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", marginBottom: 16, lineHeight: 1.5 }}>
                Este crédito cubre hasta el <strong>{Math.round(CREDIT_MAX_PERCENT * 100)}%</strong> del total de cada pedido, nunca el pedido completo, y no cubre el envío. Lo que no uses se queda disponible para tu siguiente compra.
              </div>
            )}
            {after < 0 && <div style={{ color: "var(--rust)", fontSize: 13, marginBottom: 14 }}>Aún no tienes puntos suficientes para este canje.</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button className="ch-btn ch-btn-ghost" style={{ flex: 1 }} onClick={onCancel}>Cancelar</button>
              <button className="ch-btn ch-btn-primary" style={{ flex: 1 }} onClick={onConfirm} disabled={after < 0}>Confirmar canje</button>
            </div>
          </>
        )}
        {step === "success" && (
          <div style={{ textAlign: "center" }}>
            <div style={{ width: 52, height: 52, borderRadius: 999, background: "rgba(127,184,138,0.15)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              <Check size={26} color="var(--green)" />
            </div>
            <h2 className="ch-serif" style={{ fontSize: 20, marginBottom: 18 }}>¡Recompensa desbloqueada!</h2>
            <div className="ch-card" style={{ textAlign: "left", marginBottom: 16 }}>
              <Row label="Recompensa" value={reward.name} />
              {typeof reward.creditValue !== "number" && <Row label="Código" value={code} bold />}
              <Row label="Fecha" value={formatDate(new Date().toISOString().slice(0, 10))} />
              <Row
                label="Estado"
                value={typeof reward.creditValue === "number" ? "Saldo disponible en tu cuenta" : "Pendiente de entrega"}
                bold={typeof reward.creditValue === "number"}
              />
            </div>
            {typeof reward.creditValue === "number" && (
              <p style={{ fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.5, marginBottom: 18, textAlign: "left" }}>
                Tu crédito ya está en la cuenta. En la pantalla de pago podrás usarlo — recuerda que cubre
                hasta el {Math.round(CREDIT_MAX_PERCENT * 100)}% de cada pedido, así que ajusta tu carrito según cuánto quieras aprovechar.
              </p>
            )}
            <div style={{ display: "flex", gap: 10 }}>
              <button className="ch-btn ch-btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cerrar</button>
              <button className="ch-btn ch-btn-primary" style={{ flex: 1 }} onClick={onGoMyRewards}>Ver mis recompensas</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, bold }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 13.5 }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={{ fontWeight: bold ? 700 : 500 }}>{value}</span>
    </div>
  );
}

/* ============================================================================
   CATÁLOGO
============================================================================ */
function QuantityStepper({ qty, onDecrement, onIncrement, size = "md" }) {
  const dim = size === "sm" ? 26 : 32;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size === "sm" ? 6 : 10 }}>
      <button
        onClick={onDecrement}
        disabled={qty === 0}
        style={{ width: dim, height: dim, borderRadius: 999, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text)", display: "flex", alignItems: "center", justifyContent: "center", cursor: qty === 0 ? "not-allowed" : "pointer", opacity: qty === 0 ? 0.4 : 1 }}
      >
        <Minus size={size === "sm" ? 12 : 14} />
      </button>
      <span className="ch-serif" style={{ fontSize: size === "sm" ? 14 : 16, minWidth: 18, textAlign: "center" }}>{qty}</span>
      <button
        onClick={onIncrement}
        style={{ width: dim, height: dim, borderRadius: 999, border: "1px solid var(--gold-dim)", background: "var(--gold)", color: "#14150F", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
      >
        <Plus size={size === "sm" ? 12 : 14} />
      </button>
    </div>
  );
}

function CartBar({ count, total, onView }) {
  return (
    <button onClick={onView} className="ch-cart-bar">
      <span className="ch-cart-bar-count">{count}</span>
      <span style={{ flex: 1, textAlign: "left", fontSize: 13.5, fontWeight: 600 }}>Ver pedido</span>
      <span className="ch-serif" style={{ fontSize: 15 }}>{formatMoney(total)}</span>
      <ChevronRight size={17} />
    </button>
  );
}

/* ============================================================================
   PROMOCIONES (todas las promos de todos los modelos, en un solo lugar)
============================================================================ */
// Lista de promos 2x por modelo — la comparten la página de Promociones y el
// inicio (Landing), para no mantener el mismo bloque dos veces.
function PromoByModelList({ onGoToModel }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {MODELS.filter((m) => m.available !== false).map((m) => (
        <button key={m.id} className="ch-promo-model-card" onClick={() => onGoToModel(m.id)}>
          <span style={{ fontSize: 24, flexShrink: 0 }}>{m.icon}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{m.subtitle}</div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div className="ch-serif" style={{ fontSize: 15, color: "var(--gold)" }}>2x {formatMoney(m.priceDuo)}</div>
            <div style={{ fontSize: 10.5, color: "var(--text-faint)" }}>antes {formatMoney(m.priceSingle * 2)}</div>
          </div>
          <ChevronRight size={16} color="var(--text-faint)" />
        </button>
      ))}
    </div>
  );
}

function PromotionsView({ onGoToModel }) {
  const activePromotions = PROMOTIONS.filter((p) => p.active);
  return (
    <div style={{ paddingTop: 20 }}>
      <h1 className="ch-serif" style={{ fontSize: 24 }}>Promociones</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13.5, marginTop: 4 }}>Todo lo que está en promo ahora mismo, en un solo lugar.</p>

      {activePromotions.length > 0 && (
        <>
          <h2 className="ch-section-title">Promociones generales</h2>
          {activePromotions.map((p) => (
            <div key={p.id} className="ch-promo-card" style={{ marginTop: 10 }}>
              <div className="ch-eyebrow">Vigente hasta {formatDate(p.endDate)}</div>
              <div style={{ fontFamily: "Fraunces, serif", fontSize: 17, marginBottom: 4 }}>{p.title}</div>
              <div style={{ color: "var(--text-dim)", fontSize: 13.5 }}>{p.description}</div>
            </div>
          ))}
        </>
      )}

      <h2 className="ch-section-title">Promo 2x por modelo</h2>
      <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: -6, marginBottom: 10 }}>
        Toca un modelo para ir directo a su catálogo y aprovechar la promo.
      </p>
      <PromoByModelList onGoToModel={onGoToModel} />
    </div>
  );
}

function CatalogView({ activeModelId, onChangeModel, cart, onChangeQty, stockLevels }) {
  const model = MODELS.find((m) => m.id === activeModelId) || MODELS[0];
  const products = PRODUCTS_BY_MODEL[model.id];
  const modelTabsRef = useRef(null);
  const scrollModelTabs = (dir) => {
    modelTabsRef.current?.scrollBy({ left: dir * 220, behavior: "smooth" });
  };

  return (
    <div style={{ paddingTop: 20 }}>
      <h1 className="ch-serif" style={{ fontSize: 24 }}>Catálogo</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13.5, marginTop: 4 }}>The King Shop — elige tu modelo, sabor y cantidad.</p>

      <div className="ch-model-tabs-wrap">
        <button
          type="button"
          aria-label="Modelos anteriores"
          className="ch-model-tabs-arrow ch-model-tabs-arrow-left"
          onClick={() => scrollModelTabs(-1)}
        >
          <ChevronLeft size={16} />
        </button>
        <div className="ch-model-tabs" ref={modelTabsRef}>
          {MODELS.map((m) => {
            const qtyInModel = PRODUCTS_BY_MODEL[m.id].reduce((s, p) => s + (cart[p.id] || 0), 0);
            return (
              <button
                key={m.id}
                className={"ch-model-tab" + (m.id === activeModelId ? " ch-model-tab-active" : "")}
                onClick={() => onChangeModel(m.id)}
                style={m.available === false ? { opacity: 0.55 } : undefined}
              >
                <span>{m.icon}</span>
                <span>{m.name}{m.available === false ? " (Agotado)" : ""}</span>
                {qtyInModel > 0 && <span className="ch-model-tab-badge">{qtyInModel}</span>}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-label="Más modelos"
          className="ch-model-tabs-arrow ch-model-tabs-arrow-right"
          onClick={() => scrollModelTabs(1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>

      <div className="ch-model-reference">
        {model.referenceImage ? (
          <img src={model.referenceImage} alt={model.name} />
        ) : (
          <div className="ch-model-reference-placeholder">
            <span style={{ fontSize: 40 }}>{model.icon}</span>
            <span>Imagen de referencia próximamente</span>
          </div>
        )}
      </div>

      <div className="ch-card" style={{ marginTop: 14 }}>
        <div className="ch-serif" style={{ fontSize: 18 }}>{model.name}</div>
        <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 2 }}>{model.subtitle}</div>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 14 }}>
          <div style={{ textAlign: "center", flex: 1 }}>
            <div className="ch-serif" style={{ fontSize: 18 }}>{formatMoney(model.priceSingle)}</div>
            <div style={{ fontSize: 11, color: "var(--text-faint)" }}>1 pieza</div>
          </div>
          <div style={{ width: 1, background: "var(--border)" }} />
          <div style={{ textAlign: "center", flex: 1 }}>
            <div className="ch-serif" style={{ fontSize: 18, color: "var(--gold)" }}>{formatMoney(model.priceDuo)}</div>
            <div style={{ fontSize: 11, color: "var(--text-faint)" }}>2 piezas</div>
          </div>
        </div>

        {model.specs.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 14 }}>
            {model.specs.map((s, i) => (
              <span key={i} className="ch-tag" style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}>
                {s.label}: {s.value}
              </span>
            ))}
          </div>
        )}

        {model.available === false && (
          <div className="ch-tag ch-tag-unavailable" style={{ marginTop: 14, display: "inline-block" }}>
            Agotado temporalmente
          </div>
        )}
      </div>
      <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: 8 }}>
        Envíos a domicilio con costo extra · Tarjeta, efectivo o transferencia · La promo 2x de {model.name} se aplica automáticamente al combinar sus sabores (no se mezcla con otros modelos).
      </p>

      <div className="ch-section-title" style={{ marginTop: 20, marginBottom: 0 }}>Sabores disponibles</div>
      <div className="ch-flavor-list">
        {products.map((p) => {
          const qty = cart[p.id] || 0;
          const available = isAvailable(p, stockLevels);
          const remaining = remainingStock(p, stockLevels);
          return (
            <div key={p.id} className="ch-flavor-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{p.name}</div>
                {!available ? (
                  <span className="ch-tag ch-tag-unavailable" style={{ marginTop: 4, display: "inline-block" }}>Agotado temporalmente</span>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="ch-serif" style={{ fontSize: 14, color: "var(--gold)" }}>{formatMoney(p.price)}</span>
                    {remaining <= 5 && (
                      <span style={{ fontSize: 11, color: "var(--text-faint)" }}>· quedan {remaining}</span>
                    )}
                  </div>
                )}
              </div>
              {available && (
                <QuantityStepper size="sm" qty={qty} onDecrement={() => onChangeQty(p.id, -1)} onIncrement={() => qty < remaining && onChangeQty(p.id, 1)} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProductDetailView({ product, onBack, qty, onChangeQty, onAdd, stockLevels }) {
  const [localQty, setLocalQty] = useState(1);
  if (!product) return <LockedState onLogin={onBack} message="Selecciona un producto desde el catálogo." cta="Volver al catálogo" />;
  const model = MODELS.find((m) => m.id === product.modelId);
  const available = isAvailable(product, stockLevels);
  const remaining = remainingStock(product, stockLevels);
  return (
    <div style={{ paddingTop: 20 }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: 0, marginBottom: 16 }}>
        <ArrowLeft size={16} /> Volver
      </button>
      <div className="ch-product-art" style={{ height: 200, borderRadius: "var(--radius-m)", fontSize: 60 }}>
        <ArtIcon kind={product.image} />
      </div>
      {model && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 14, fontSize: 12, color: "var(--text-faint)" }}>
          <span>{model.icon}</span><span>{model.name} · {model.subtitle}</span>
        </div>
      )}
      <h1 className="ch-serif" style={{ fontSize: 24, marginTop: 6 }}>{product.name}</h1>
      <div className="ch-serif" style={{ fontSize: 20, color: "var(--gold)", margin: "6px 0" }}>{formatMoney(product.price)}</div>
      {model && (
        <p style={{ color: "var(--text-faint)", fontSize: 12, marginTop: -4, marginBottom: 8 }}>
          Promo de este modelo: 2 piezas por {formatMoney(model.priceDuo)}
        </p>
      )}
      {available && remaining <= 5 && (
        <div style={{ fontSize: 12.5, color: "var(--text-faint)", marginTop: 2 }}>Quedan {remaining} en stock.</div>
      )}
      {qty > 0 && <div style={{ fontSize: 12.5, color: "var(--gold)", marginTop: 6 }}>Ya tienes {qty} en tu pedido.</div>}

      {!available ? (
        <div className="ch-card" style={{ marginTop: 18, textAlign: "center", color: "var(--text-dim)", fontSize: 13.5 }}>
          Este producto no está disponible temporalmente.
        </div>
      ) : (
        <div style={{ marginTop: 24 }}>
          <div className="ch-card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <span style={{ fontSize: 13.5, color: "var(--text-dim)" }}>Cantidad</span>
            <QuantityStepper qty={localQty} onDecrement={() => setLocalQty((q) => Math.max(1, q - 1))} onIncrement={() => setLocalQty((q) => Math.min(remaining, q + 1))} />
          </div>
          <button className="ch-btn ch-btn-primary ch-btn-block" onClick={() => onAdd(product, localQty)}>
            Añadir al pedido · {formatMoney(product.price * localQty)}
          </button>
        </div>
      )}
    </div>
  );
}

function CartView({ cartList, pricing, onChangeQty, onBack, onGoToCheckout }) {
  if (cartList.length === 0) {
    return (
      <div style={{ paddingTop: 20 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: 0, marginBottom: 16 }}>
          <ArrowLeft size={16} /> Volver
        </button>
        <LockedState onLogin={onBack} message="Tu pedido está vacío. Agrega sabores desde el catálogo." cta="Ir al catálogo" />
      </div>
    );
  }
  return (
    <div style={{ paddingTop: 20 }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: 0, marginBottom: 16 }}>
        <ArrowLeft size={16} /> Seguir comprando
      </button>
      <h1 className="ch-serif" style={{ fontSize: 24 }}>Tu pedido</h1>

      {pricing.modelBreakdown.map((mb) => (
        <div key={mb.modelId} style={{ marginTop: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
            <span>{mb.model.icon}</span>
            <span className="ch-serif" style={{ fontSize: 15 }}>{mb.model.name}</span>
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>· {mb.model.subtitle}</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {mb.items.map((item) => (
              <div key={item.product.id} className="ch-card" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div className="ch-reward-art" style={{ width: 44, height: 44 }}><ArtIcon kind={item.product.image} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{item.product.name}</div>
                  <div style={{ fontSize: 12, color: "var(--text-faint)" }}>{formatMoney(item.product.price)} c/u</div>
                </div>
                <QuantityStepper size="sm" qty={item.qty} onDecrement={() => onChangeQty(item.product.id, -1)} onIncrement={() => onChangeQty(item.product.id, 1)} />
              </div>
            ))}
          </div>

          <div className="ch-card" style={{ marginTop: 10 }}>
            <Row label={`Subtotal (${mb.totalQty} piezas a precio individual)`} value={formatMoney(mb.naiveTotal)} />
            {mb.bundles > 0 && (
              <Row label={`Promoción 2x${formatMoney(mb.model.priceDuo)} aplicada (x${mb.bundles})`} value={"–" + formatMoney(mb.savings)} />
            )}
            <Row label={`Total ${mb.model.name}`} value={formatMoney(mb.total)} bold />
          </div>
        </div>
      ))}

      <div className="ch-card" style={{ marginTop: 20 }}>
        <Row label="Total del pedido" value={formatMoney(pricing.total)} bold />
        {pricing.savings > 0 && <Row label="Ahorro total por promociones" value={"–" + formatMoney(pricing.savings)} />}
        <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 8, lineHeight: 1.5 }}>
          Desglose: {describeBundleBreakdown(pricing)}.
        </div>
      </div>

      <button
        className="ch-btn ch-btn-primary ch-btn-block"
        style={{ marginTop: 18 }}
        onClick={onGoToCheckout}
      >
        Continuar con el pedido <ChevronRight size={16} />
      </button>
    </div>
  );
}

function CheckoutView({ cartList, pricing, checkoutInfo, setCheckoutInfo, creditAvailable = 0, onBack, waLink, buildCartMessage, onConfirm, navigateAfterConfirm }) {
  const [touched, setTouched] = useState(false);
  if (cartList.length === 0) {
    return (
      <div style={{ paddingTop: 20 }}>
        <button onClick={onBack} style={{ background: "none", border: "none", color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: 0, marginBottom: 16 }}>
          <ArrowLeft size={16} /> Volver
        </button>
        <LockedState onLogin={onBack} message="Tu pedido está vacío. Agrega sabores desde el catálogo." cta="Ir al catálogo" />
      </div>
    );
  }

  const isValid = !!checkoutInfo.paymentMethod && checkoutInfo.address.trim().length > 0;
  // El crédito se aplica entero hasta donde alcance, pero nunca por encima del
  // 30% del pedido (ver CREDIT_MAX_PERCENT) — es la regla que evita que una
  // compra salga gratis o que la tienda pierda dinero en ella.
  const creditCap = maxCreditForOrder(pricing.total);
  const creditUsed = checkoutInfo.useCredit ? creditAppliedFor(pricing.total, creditAvailable) : 0;
  const cappedByRule = checkoutInfo.useCredit && creditAvailable > creditCap;
  const toPay = pricing.total - creditUsed;
  const message = buildCartMessage(cartList, pricing, { ...checkoutInfo, creditUsed, toPay });

  function paymentIcon(icon) {
    if (icon === "cash") return <Banknote size={18} />;
    if (icon === "transfer") return <Landmark size={18} />;
    return <CreditCard size={18} />;
  }

  function handleSend(e) {
    if (!isValid) {
      e.preventDefault();
      setTouched(true);
      return;
    }
    onConfirm(checkoutInfo);
    navigateAfterConfirm();
  }

  return (
    <div style={{ paddingTop: 20 }}>
      <button onClick={onBack} style={{ background: "none", border: "none", color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: 0, marginBottom: 16 }}>
        <ArrowLeft size={16} /> Volver al pedido
      </button>
      <h1 className="ch-serif" style={{ fontSize: 24 }}>Cómo quieres pagar y recibirlo</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: 4 }}>
        Esto se incluye en el mensaje que enviaremos por WhatsApp para confirmar tu pedido.
      </p>

      <div style={{ marginTop: 20 }}>
        <div className="ch-label" style={{ marginBottom: 10 }}>Método de pago</div>
        {PAYMENT_METHODS.map((m) => (
          <div
            key={m.id}
            className={"ch-pay-option" + (checkoutInfo.paymentMethod === m.id ? " ch-pay-option-active" : "")}
            onClick={() => setCheckoutInfo((c) => ({ ...c, paymentMethod: m.id }))}
          >
            <div className="ch-pay-option-icon">{paymentIcon(m.icon)}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{m.label}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>{m.description}</div>
            </div>
            <div className={"ch-pay-radio" + (checkoutInfo.paymentMethod === m.id ? " ch-pay-radio-active" : "")} />
          </div>
        ))}
        {touched && !checkoutInfo.paymentMethod && (
          <div style={{ color: "var(--rust)", fontSize: 12, marginTop: 4 }}>Elige un método de pago.</div>
        )}
      </div>

      <div style={{ marginTop: 22 }}>
        <div className="ch-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <MapPin size={14} /> Dirección de entrega
        </div>
        <div className="ch-input-group" style={{ marginTop: 6 }}>
          <input
            className="ch-input"
            value={checkoutInfo.address}
            onChange={(e) => setCheckoutInfo((c) => ({ ...c, address: e.target.value }))}
            placeholder="Calle, número, colonia, ciudad"
          />
        </div>
        {touched && !checkoutInfo.address.trim() && (
          <div style={{ color: "var(--rust)", fontSize: 12, marginTop: -10, marginBottom: 10 }}>Escribe la dirección de entrega.</div>
        )}
        <label className="ch-label">Referencia del lugar (opcional)</label>
        <textarea
          className="ch-input ch-textarea"
          value={checkoutInfo.reference}
          onChange={(e) => setCheckoutInfo((c) => ({ ...c, reference: e.target.value }))}
          placeholder="Ej. Casa color azul con portón negro, frente a la tienda OXXO · Depa 3B, edificio con fachada gris"
          rows={3}
        />
      </div>

      {creditAvailable > 0 && (
        <div className="ch-card" style={{ marginTop: 20, borderColor: "var(--gold-dim)" }}>
          <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
            <input
              type="checkbox"
              checked={!!checkoutInfo.useCredit}
              onChange={(e) => setCheckoutInfo((c) => ({ ...c, useCredit: e.target.checked }))}
              style={{ marginTop: 3, width: 17, height: 17, accentColor: "var(--gold)" }}
              id="ch-use-credit"
            />
            <label htmlFor="ch-use-credit" style={{ flex: 1, cursor: "pointer" }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                Usar mi crédito de {formatMoney(creditAvailable)}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 3, lineHeight: 1.45 }}>
                Cubre hasta el {Math.round(CREDIT_MAX_PERCENT * 100)}% del total de tu pedido. Lo que no se use por este límite se queda en tu cuenta para tu siguiente compra.
              </div>
              {checkoutInfo.useCredit && (
                <div style={{ fontSize: 11.5, color: "var(--gold)", marginTop: 6 }}>
                  En este pedido de {formatMoney(pricing.total)} se aplican {formatMoney(creditUsed)}{cappedByRule ? ` (tope del ${Math.round(CREDIT_MAX_PERCENT * 100)}%)` : ""}.
                </div>
              )}
            </label>
          </div>
        </div>
      )}

      {/* Aviso de envío: siempre visible, para todos, y más notorio si hay
          crédito aplicado (para que quede claro que el envío no baja a $0). */}
      <div
        className="ch-card"
        style={{
          marginTop: 14,
          background: creditUsed > 0 ? "rgba(196,120,95,0.08)" : "var(--surface)",
          borderColor: creditUsed > 0 ? "var(--rust)" : "var(--border)",
          display: "flex", gap: 10, alignItems: "flex-start",
        }}
      >
        <MapPin size={16} color={creditUsed > 0 ? "var(--rust)" : "var(--text-dim)"} style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.5 }}>
          El costo de envío <strong>no está incluido</strong> en este total{creditUsed > 0 ? " ni se cubre con tu crédito" : ""}.
          Se cotiza por WhatsApp según tu zona al confirmar el pedido.
        </div>
      </div>

      <div className="ch-card" style={{ marginTop: creditAvailable > 0 ? 12 : 20 }}>
        <Row label="Subtotal del pedido" value={formatMoney(pricing.total)} />
        {creditUsed > 0 && (
          <Row label="Crédito de recompensas aplicado" value={"–" + formatMoney(creditUsed)} />
        )}
        <Row label="Total a pagar" value={formatMoney(toPay)} bold />
        {creditUsed > 0 && creditAvailable - creditUsed > 0 && (
          <div style={{ fontSize: 11.5, color: "var(--gold)", paddingTop: 6 }}>
            Te quedan {formatMoney(creditAvailable - creditUsed)} de crédito para tu siguiente pedido.
          </div>
        )}
      </div>

      <a
        className="ch-btn ch-btn-primary ch-btn-block ch-link-plain"
        style={{ marginTop: 18, opacity: isValid ? 1 : 0.55 }}
        href={isValid ? waLink(message) : undefined}
        target="_blank" rel="noopener noreferrer"
        onClick={handleSend}
      >
        <MessageCircle size={16} /> Finalizar pedido por WhatsApp
      </a>
    </div>
  );
}

function OrderSuccessView({ order, onDone }) {
  return (
    <div style={{ paddingTop: 40, textAlign: "center" }}>
      <div style={{ width: 52, height: 52, borderRadius: 999, background: "rgba(127,184,138,0.15)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
        <Check size={26} color="var(--green)" />
      </div>
      <h1 className="ch-serif" style={{ fontSize: 22 }}>¡Tu pedido fue registrado!</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13.5, marginTop: 6 }}>Lo enviamos por WhatsApp para confirmar entrega y pago.</p>

      <div className="ch-card" style={{ textAlign: "left", marginTop: 20 }}>
        {order.items.map((it, i) => <Row key={i} label={`${it.qty} x ${it.name}`} value="" />)}
        <Row label="Subtotal" value={formatMoney(order.subtotal ?? order.pricing.total)} />
        {order.creditUsed > 0 && <Row label="Crédito de recompensas" value={"–" + formatMoney(order.creditUsed)} />}
        <Row label="Total a pagar" value={formatMoney(order.total ?? order.pricing.total)} bold />
        {order.pointsEarned !== null && <Row label="Puntos obtenidos" value={"+" + formatPoints(order.pointsEarned)} bold />}
      </div>

      {(order.paymentMethod || order.address) && (
        <div className="ch-card" style={{ textAlign: "left", marginTop: 12 }}>
          {order.paymentMethod && <Row label="Método de pago" value={PAYMENT_METHODS.find((m) => m.id === order.paymentMethod)?.label || order.paymentMethod} />}
          {order.address && (
            <div style={{ padding: "8px 0" }}>
              <div style={{ color: "var(--text-dim)", fontSize: 13.5, marginBottom: 4 }}>Dirección</div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>{order.address}</div>
              {order.reference && <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 4 }}>Referencia: {order.reference}</div>}
            </div>
          )}
        </div>
      )}

      <button className="ch-btn ch-btn-primary ch-btn-block" style={{ marginTop: 22 }} onClick={onDone}>
        {order.guest ? "Volver al catálogo" : "Ver mis pedidos"}
      </button>
    </div>
  );
}

/* ============================================================================
   PEDIDOS
============================================================================ */
function OrdersView({ orders, transactions, onGoHistory, onRetrySync }) {
  return (
    <div style={{ paddingTop: 20 }}>
      <h1 className="ch-serif" style={{ fontSize: 24 }}>Mis pedidos</h1>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 18 }}>
        <h2 className="ch-section-title" style={{ margin: 0 }}>Actividad reciente</h2>
      </div>
      <div className="ch-card" style={{ marginTop: 10, marginBottom: 22 }}>
        {(!transactions || transactions.length === 0) && <EmptyRow text="Aún no tienes movimientos." />}
        {(transactions || []).slice(0, 4).map((t) => <ActivityRow key={t.id} t={t} />)}
        {transactions && transactions.length > 0 && (
          <button onClick={onGoHistory} className="ch-btn ch-btn-ghost ch-btn-block" style={{ marginTop: 14 }}>Ver historial completo</button>
        )}
      </div>

      <h2 className="ch-section-title" style={{ margin: "0 0 10px" }}>Pedidos</h2>
      {orders.length === 0 ? (
        <div className="ch-card" style={{ marginTop: 20 }}><EmptyRow text="Aún no tienes pedidos. Explora el catálogo para hacer el primero." /></div>
      ) : (
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {orders.map((o) => (
            <div key={o.id} className="ch-card">
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Pedido #{o.id.replace(/\D/g, "").slice(-5) || "10482"}</span>
                <span className="ch-tag ch-tag-almost">{o.status}</span>
              </div>
              <div style={{ color: "var(--text-faint)", fontSize: 12.5, margin: "4px 0 10px" }}>{formatDate(o.date)}</div>
              {o.items && o.items.length > 0 && (
                <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginBottom: 8 }}>
                  {o.items.map((it, i) => <div key={i}>{it.qty} x {it.name}</div>)}
                </div>
              )}
              {o.creditUsed > 0 && <Row label="Subtotal" value={formatMoney(o.subtotal ?? o.total)} />}
              {o.creditUsed > 0 && <Row label="Crédito de recompensas" value={"–" + formatMoney(o.creditUsed)} />}
              <Row label={o.creditUsed > 0 ? "Total a pagar" : "Total"} value={formatMoney(o.total)} />
              <Row label="Puntos obtenidos" value={"+" + formatPoints(o.pointsEarned)} bold />
              {o.paymentMethod && <Row label="Pago" value={PAYMENT_METHODS.find((m) => m.id === o.paymentMethod)?.label || o.paymentMethod} />}
              {o.address && (
                <div style={{ padding: "8px 0 0" }}>
                  <div style={{ color: "var(--text-dim)", fontSize: 12.5, marginBottom: 3 }}>Dirección</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.5 }}>{o.address}{o.reference ? ` · ${o.reference}` : ""}</div>
                </div>
              )}
              {o.syncError && o.status === "Pendiente" && !o.dbOrderId && (
                <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, background: "rgba(196,120,95,0.08)", border: "1px solid var(--rust)" }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--rust)" }}>⚠️ No se sincronizó con el panel</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.45, wordBreak: "break-word" }}>{o.syncError}</div>
                  {onRetrySync && (
                    <button onClick={() => onRetrySync(o)} className="ch-btn ch-btn-secondary" style={{ marginTop: 8 }}>Reintentar</button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ============================================================================
   REFERIDOS
============================================================================ */
function ReferralsView({ customer, stats, onCopy, onShared }) {
  const [copied, setCopied] = useState(false);
  const link = referralLink(customer.referralCode);

  // Copiado real al portapapeles, con respaldo para navegadores viejos o
  // contextos sin permiso (el enlace nunca se queda sin copiar).
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = link;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (e2) { /* sin portapapeles */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    onCopy();
    onShared();
    window.setTimeout(() => setCopied(false), 1800);
  }

  // Compartir nativo (WhatsApp, mensajes, etc.) donde el dispositivo lo permita.
  async function share() {
    const text = `Te comparto The King Shop. Entra con mi enlace y los dos ganamos puntos: ${link}`;
    if (navigator.share) {
      try { await navigator.share({ title: "The King Shop", text, url: link }); onShared(); return; } catch (e) { return; }
    }
    window.open(waLink(text), "_blank", "noopener,noreferrer");
    onShared();
  }

  return (
    <div style={{ paddingTop: 20 }}>
      <h1 className="ch-serif" style={{ fontSize: 24 }}>Invita a un amigo</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13.5, marginTop: 4 }}>
        Ganas {formatPoints(REFERRAL_POINTS_REFERRER)} puntos cuando tu invitado hace su primera compra. Él empieza con {formatPoints(REFERRAL_POINTS_REFERRED)}.
      </p>

      <div className="ch-card" style={{ marginTop: 18, textAlign: "center" }}>
        <div style={{ fontSize: 12, color: "var(--text-dim)" }}>Tu código</div>
        <div className="ch-serif" style={{ fontSize: 24, margin: "6px 0 14px" }}>{customer.referralCode}</div>
        <div style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 12px", fontSize: 12, color: "var(--text-dim)", marginBottom: 14, wordBreak: "break-all" }}>
          {link}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button className="ch-btn ch-btn-secondary" style={{ flex: 1 }} onClick={copy}>
            {copied ? <><Check size={15} /> Copiado</> : <><Copy size={15} /> Copiar enlace</>}
          </button>
          <button className="ch-btn ch-btn-primary" style={{ flex: 1 }} onClick={share}>Compartir</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 18 }}>
        <StatBox label="Veces compartido" value={stats.invited} />
        <StatBox label="Se registraron" value={stats.registered} />
        <StatBox label="Ya compraron" value={stats.purchased} />
        <StatBox label="Puntos ganados" value={formatPoints(stats.pointsEarned)} />
      </div>

      <div className="ch-section-title" style={{ marginTop: 22 }}>Tus invitados</div>
      <div className="ch-card">
        {stats.friends.length === 0 ? (
          <EmptyRow text="Todavía nadie se registra con tu enlace." />
        ) : stats.friends.map((f) => (
          <div key={f.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{f.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
                Se registró el {formatDate(f.joinedAt)}
                {f.firstPurchaseAt ? ` · compró el ${formatDate(f.firstPurchaseAt)}` : ""}
              </div>
            </div>
            <span className={"ch-tag " + (f.rewarded ? "ch-tag-available" : "ch-tag-almost")} style={{ flexShrink: 0 }}>
              {f.rewarded ? `+${formatPoints(REFERRAL_POINTS_REFERRER)} pts` : "Falta su 1ª compra"}
            </span>
          </div>
        ))}
      </div>

      <p style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 16, lineHeight: 1.5 }}>
        El enlace deja marcada la invitación en la cuenta de tu amigo desde que se registra. Los puntos se acreditan
        cuando su primera compra queda confirmada, así haya sido por la página o por WhatsApp.
      </p>
    </div>
  );
}
function StatBox({ label, value }) {
  return (
    <div className="ch-card" style={{ textAlign: "center" }}>
      <div className="ch-serif" style={{ fontSize: 22 }}>{value}</div>
      <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 4 }}>{label}</div>
    </div>
  );
}

/* ============================================================================
   PERFIL
============================================================================ */
function ProfileView({ customer, onSave, onLogout }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ name: customer.name, phone: customer.phone, email: customer.email || "" });

  function save() {
    onSave(form);
    setEditing(false);
  }

  return (
    <div style={{ paddingTop: 20 }}>
      <h1 className="ch-serif" style={{ fontSize: 24 }}>Mi perfil</h1>

      <div className="ch-card" style={{ marginTop: 18 }}>
        {editing ? (
          <>
            <div className="ch-input-group"><label className="ch-label">Nombre</label><input className="ch-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div className="ch-input-group"><label className="ch-label">Teléfono</label><input className="ch-input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
            <div className="ch-input-group"><label className="ch-label">Email</label><input className="ch-input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="ch-btn ch-btn-ghost" style={{ flex: 1 }} onClick={() => setEditing(false)}>Cancelar</button>
              <button className="ch-btn ch-btn-primary" style={{ flex: 1 }} onClick={save}>Guardar</button>
            </div>
          </>
        ) : (
          <>
            <Row label="Nombre" value={customer.name} />
            <Row label="Teléfono" value={customer.phone} />
            <Row label="Email" value={customer.email} />
            <Row label="Fecha de registro" value={formatDate(customer.createdAt)} />
            <Row label="ID de cliente" value={customer.id} />
            <Row label="Nivel" value={customer.membershipLevel} />
            <button className="ch-btn ch-btn-secondary ch-btn-block" style={{ marginTop: 16 }} onClick={() => setEditing(true)}>Editar perfil</button>
          </>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
        <StatBox label="Puntos actuales" value={formatPoints(customer.pointsBalance)} />
        <StatBox label="Total gastado" value={formatMoney(customer.totalSpent)} />
        <StatBox label="Número de compras" value={customer.totalPurchases} />
        <StatBox label="Última compra" value={customer.lastPurchase ? formatDate(customer.lastPurchase) : "—"} />
      </div>

      <button className="ch-btn ch-btn-ghost ch-btn-block" style={{ marginTop: 22 }} onClick={onLogout}>
        <LogOut size={16} /> Cerrar sesión
      </button>
    </div>
  );
}

/* ============================================================================
   HISTORIAL DE PUNTOS
============================================================================ */
function PointsHistoryView({ customer, transactions, filter, setFilter }) {
  const earned = transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const used = transactions.filter((t) => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0);

  const filters = [
    { id: "all", label: "Todos" },
    { id: "earned", label: "Ganados" },
    { id: "used", label: "Utilizados" },
    { id: "bonus", label: "Bonificaciones" },
  ];

  return (
    <div style={{ paddingTop: 20 }}>
      <h1 className="ch-serif" style={{ fontSize: 24 }}>Mis puntos</h1>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 16 }}>
        <StatBox label="Saldo actual" value={formatPoints(customer.pointsBalance)} />
        <StatBox label="Ganados" value={formatPoints(earned)} />
        <StatBox label="Utilizados" value={formatPoints(used)} />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 20, overflowX: "auto", paddingBottom: 2 }}>
        {filters.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={"ch-btn " + (filter === f.id ? "ch-btn-primary" : "ch-btn-secondary")}
            style={{ padding: "8px 14px", fontSize: 12.5, whiteSpace: "nowrap" }}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="ch-card" style={{ marginTop: 16 }}>
        {transactions.length === 0 ? <EmptyRow text="Sin movimientos en este filtro." /> : transactions.map((t) => <ActivityRow key={t.id} t={t} />)}
      </div>
    </div>
  );
}

/* ============================================================================
   ESTADO BLOQUEADO (sin sesión en zonas protegidas)
============================================================================ */
function LockedState({ onLogin, message, cta }) {
  return (
    <div className="ch-locked">
      <div style={{ width: 52, height: 52, borderRadius: 999, background: "var(--surface-2)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px" }}>
        <Lock size={22} color="var(--text-dim)" />
      </div>
      <p style={{ color: "var(--text-dim)", fontSize: 14.5, marginBottom: 20 }}>
        {message || "Inicia sesión para consultar tu cuenta."}
      </p>
      <button className="ch-btn ch-btn-primary" onClick={onLogin}>{cta || "Iniciar sesión"}</button>
    </div>
  );
}

/* ============================================================================
   PANEL DE ADMINISTRADOR (reportes internos — NO es para clientes)
   ⚠️ Importante: esta vista hoy es accesible desde el menú como cualquier
   otra. Antes de usarla en producción hay que protegerla con un inicio de
   sesión de administrador separado (roles/permiso), para que ningún cliente
   pueda verla. Con el estado actual (en memoria del navegador) los números
   son demo/locales; para que reflejen a todos los clientes reales hace falta
   mover customers/orders a un backend (ver nota de arquitectura al final).
============================================================================ */
function AdminOrdersTab({ stats, customers, onConfirmOrder, onCancelOrder, onUpdateOrderItemQty, onRefresh, refreshing, soundOn, onToggleSound, rewardsToDeliver = [], onMarkRewardDelivered }) {
  const customerById = (id) => customers.find((c) => c.id === id);
  const statusColor = (s) => s === "Completado" ? "var(--green)" : s === "Cancelado" ? "var(--text-faint)" : "var(--gold)";
  const history = [...stats.allOrders].sort((a, b) => (a.date < b.date ? 1 : -1));
  const [confirmingId, setConfirmingId] = useState(null);
  const [confirmError, setConfirmError] = useState(null); // { orderId, text }
  const [syncInfo, setSyncInfo] = useState(null); // resultado de la última lectura a Supabase

  async function handleRefresh() {
    if (!onRefresh) return;
    setSyncInfo(null);
    const r = await onRefresh();
    setSyncInfo(r || null);
  }
  useEffect(() => { handleRefresh(); }, []);

  async function handleCancel(order) {
    if (!window.confirm("¿Cancelar este pedido? No se descuenta stock ni se dan puntos.")) return;
    setConfirmingId(order.id);
    setConfirmError(null);
    const result = await onCancelOrder(order.customerId, order.id);
    setConfirmingId(null);
    if (!result?.ok) setConfirmError({ orderId: order.id, text: result?.error || "No se pudo cancelar el pedido." });
  }

  async function handleConfirm(order) {
    setConfirmingId(order.id);
    setConfirmError(null);
    const result = await onConfirmOrder(order.customerId, order.id);
    setConfirmingId(null);
    if (!result.ok) setConfirmError({ orderId: order.id, text: result.error || "No se pudo confirmar el pedido." });
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, marginTop: 18, marginBottom: 10 }}>
        <div className="ch-section-title" style={{ marginTop: 0, marginBottom: 0, flex: "1 1 160px", minWidth: 0 }}>
          Pedidos por confirmar {stats.pendingOrders.length > 0 && `(${stats.pendingOrders.length})`}
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          {onToggleSound && (
            <button
              onClick={onToggleSound}
              title={soundOn ? "Sonido de pedidos nuevos activado" : "Sonido silenciado"}
              style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "6px 10px", fontSize: 12, color: "var(--text-dim)", cursor: "pointer", fontFamily: "'Inter', sans-serif", whiteSpace: "nowrap" }}
            >
              {soundOn ? "🔔 Sonido" : "🔕 Silencio"}
            </button>
          )}
          {onRefresh && (
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              style={{ background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "6px 10px", fontSize: 12, color: "var(--text-dim)", cursor: refreshing ? "default" : "pointer", fontFamily: "'Inter', sans-serif", whiteSpace: "nowrap" }}
            >
              {refreshing ? "Actualizando…" : "Actualizar"}
            </button>
          )}
        </div>
      </div>
      <p style={{ color: "var(--text-faint)", fontSize: 12, marginTop: -6, marginBottom: 10 }}>
        Ajusta cantidades si algo cambió en WhatsApp, y confirma solo cuando el pago ya se haya recibido —
        ahí se descuenta el stock real y se otorgan los puntos. El panel se actualiza solo cada
        20 segundos y suena una campanita cuando llega un pedido nuevo (toca cualquier parte de la
        página una vez para que el navegador permita el sonido).
      </p>
      {syncInfo && (syncInfo.error || (syncInfo.diag && (!syncInfo.diag.hasSession || !syncInfo.diag.isAdmin || syncInfo.diag.clientesError))) && (
        <div style={{ fontSize: 11.5, lineHeight: 1.5, padding: "8px 10px", borderRadius: 10, marginBottom: 10, background: syncInfo.error || (syncInfo.diag && !syncInfo.diag.isAdmin) ? "rgba(196,120,95,0.08)" : "var(--surface-2)", border: "1px solid " + (syncInfo.error || (syncInfo.diag && !syncInfo.diag.isAdmin) ? "var(--rust)" : "var(--border)"), color: "var(--text-dim)", wordBreak: "break-word" }}>
          {syncInfo.error && <>⚠️ {syncInfo.error}</>}
          {syncInfo.diag && (
            <>
              {!syncInfo.diag.hasSession && <div>⚠️ Esta pestaña no tiene sesión de Supabase. Cierra sesión de admin y vuelve a entrar con correo y contraseña.</div>}
              {syncInfo.diag.hasSession && !syncInfo.diag.isAdmin && <div>⚠️ La sesión activa no es de administrador (¿quedó una cuenta de cliente abierta en este navegador?). Cierra sesión y entra como admin.</div>}
              {syncInfo.diag.clientesError && <div>⚠️ No se pudieron leer los clientes: {syncInfo.diag.clientesError}</div>}
            </>
          )}
        </div>
      )}
      {stats.pendingOrders.length === 0 ? (
        <div className="ch-card"><EmptyRow text="No hay pedidos pendientes por confirmar." /></div>
      ) : stats.pendingOrders.map((order) => {
        const customer = customerById(order.customerId);
        return (
          <div key={order.id} className="ch-card" style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontWeight: 600, fontSize: 14.5 }}>
                {customer?.name || "Cliente"}
                {customer?.status === "provisional" && <span style={{ color: "var(--gold)", fontWeight: 600 }}> · Sin registrar</span>}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-faint)" }}>Folio {order.id} · {formatDate(order.date)}</div>
            </div>
            {customer?.phone && (
              <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 2 }}>{customer.phone}</div>
            )}
            <div style={{ marginTop: 10 }}>
              {order.items.map((item, idx) => (
                <div key={idx} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6 }}>
                  <div style={{ fontSize: 13, flex: 1, minWidth: 0 }}>{item.name} <span style={{ color: "var(--text-faint)" }}>· {formatMoney(item.price)} c/u</span></div>
                  <QuantityStepper
                    size="sm"
                    qty={item.qty}
                    onDecrement={() => onUpdateOrderItemQty(order.customerId, order.id, idx, item.qty - 1)}
                    onIncrement={() => onUpdateOrderItemQty(order.customerId, order.id, idx, item.qty + 1)}
                  />
                </div>
              ))}
            </div>
            <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8 }}>
              {order.creditUsed > 0 && (
                <>
                  {/* Aviso para quien cobra: este pedido trae crédito aplicado,
                      el cliente NO debe pagar el subtotal. */}
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--text-dim)" }}>
                    <span>Subtotal de productos</span><span>{formatMoney(order.subtotal ?? order.total)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "var(--gold)", marginTop: 3 }}>
                    <span>Crédito de recompensas aplicado</span><span>–{formatMoney(order.creditUsed)}</span>
                  </div>
                </>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: order.creditUsed > 0 ? 6 : 0 }}>
                <span style={{ color: "var(--text-dim)" }}>{order.creditUsed > 0 ? "Cobrar al cliente" : "Total"}</span>
                <span className="ch-serif" style={{ color: "var(--gold)" }}>{formatMoney(order.total)}</span>
              </div>
            </div>
            {confirmError?.orderId === order.id && (
              <div style={{ color: "var(--rust)", fontSize: 12, marginTop: 8 }}>{confirmError.text}</div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button className="ch-btn ch-btn-ghost" style={{ flex: 1 }} disabled={confirmingId === order.id} onClick={() => handleCancel(order)}>Cancelar</button>
              <button className="ch-btn ch-btn-primary" style={{ flex: 1 }} disabled={confirmingId === order.id} onClick={() => handleConfirm(order)}>
                {confirmingId === order.id ? "Confirmando…" : "Confirmar pagado"}
              </button>
            </div>
          </div>
        );
      })}

      {rewardsToDeliver.length > 0 && (
        <>
          <div className="ch-section-title" style={{ marginTop: 22 }}>Recompensas por entregar ({rewardsToDeliver.length})</div>
          {rewardsToDeliver.map((rw) => {
            const def = REWARDS.find((r) => r.id === rw.rewardId);
            return (
              <div key={rw.id} className="ch-card" style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{def?.name || rw.rewardId}</div>
                <div style={{ fontSize: 12.5, color: "var(--text-dim)", marginTop: 4, lineHeight: 1.5 }}>
                  {rw.customerName}{rw.customerPhone ? ` · ${rw.customerPhone}` : ""}{rw.customerEmail ? ` · ${rw.customerEmail}` : ""}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 2 }}>Código {rw.code} · canjeada el {formatDate(rw.createdAt)}</div>
                <button
                  className="ch-btn ch-btn-secondary"
                  style={{ marginTop: 10 }}
                  onClick={async () => {
                    const r = await onMarkRewardDelivered(rw.dbId);
                    if (r && r.error) setConfirmError({ orderId: "reward_" + rw.id, text: r.error });
                  }}
                >
                  Marcar como entregada
                </button>
                {confirmError?.orderId === "reward_" + rw.id && (
                  <div style={{ color: "var(--rust)", fontSize: 12, marginTop: 8 }}>{confirmError.text}</div>
                )}
              </div>
            );
          })}
        </>
      )}

      <div className="ch-section-title" style={{ marginTop: 22 }}>Historial de pedidos (todos)</div>
      <div className="ch-card">
        {history.length === 0 ? (
          <EmptyRow text="Todavía no hay pedidos registrados." />
        ) : history.map((o) => (
          <div key={o.id} style={{ padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>
                {customerById(o.customerId)?.name || "Cliente"}
                {customerById(o.customerId)?.status === "provisional" && (
                  <span style={{ color: "var(--gold)", fontWeight: 600 }}> · Sin registrar</span>
                )}
                {" "}· Folio {o.id}
              </span>
              <span style={{ color: statusColor(o.status), fontWeight: 600 }}>{o.status}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--text-faint)", marginTop: 2 }}>
              <span>{formatDate(o.date)} · {o.origin === "whatsapp" ? "WhatsApp" : "Página"} · {(o.items || []).reduce((s, i) => s + i.qty, 0)} pzs</span>
              <span>{formatMoney(o.total)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminBreakdownRow({ rowKey, label, qty, maxQty, color, buyers, expandedKey, onToggle }) {
  const isOpen = expandedKey === rowKey;
  return (
    <div style={{ marginBottom: 12 }}>
      <button
        onClick={() => onToggle(isOpen ? null : rowKey)}
        style={{ background: "none", border: "none", padding: 0, width: "100%", textAlign: "left", cursor: "pointer" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <ChevronDown size={13} style={{ transform: isOpen ? "rotate(180deg)" : "none", color: "var(--text-faint)" }} />
            {label}
          </span>
          <span style={{ color: "var(--text-dim)" }}>{qty} pzs</span>
        </div>
        <div style={{ height: 6, background: "var(--surface-2)", borderRadius: 999, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${(qty / maxQty) * 100}%`, background: color, borderRadius: 999 }} />
        </div>
      </button>
      {isOpen && (
        <div style={{ marginTop: 8, marginLeft: 17, borderLeft: "2px solid var(--border)", paddingLeft: 10 }}>
          {[...buyers].sort((a, b) => (a.date < b.date ? 1 : -1)).map((b, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-dim)", padding: "3px 0" }}>
              <span>{b.customerName}{b.flavor ? ` · ${b.flavor}` : ""}</span>
              <span>{b.qty} pzs · {formatDate(b.date)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   GRÁFICA DE VENTAS POR DÍA
   Barras en SVG puro (sin librerías de gráficas) para que funcione igual
   dentro de la app que en cualquier build. Se puede alternar entre piezas
   vendidas, número de pedidos e ingresos: la altura de la barra cambia,
   la lectura no.
---------------------------------------------------------------------------- */
function SalesChart({ dailyStats }) {
  const [metric, setMetric] = useState("units");
  const METRICS = [
    { id: "units", label: "Piezas", get: (d) => d.units, fmt: (v) => `${v} pzs` },
    { id: "orders", label: "Pedidos", get: (d) => d.orders.length, fmt: (v) => `${v}` },
    { id: "revenue", label: "Ingresos", get: (d) => d.revenue, fmt: (v) => formatMoney(v) },
  ];
  const active = METRICS.find((m) => m.id === metric);

  // Los últimos 14 días con venta, del más viejo al más nuevo.
  const data = useMemo(() => [...dailyStats].slice(0, 14).reverse(), [dailyStats]);
  const max = Math.max(1, ...data.map(active.get));
  const todayStr = new Date().toISOString().slice(0, 10);

  const W = 320, H = 132, padB = 18, padT = 10;
  const slot = data.length ? W / data.length : W;
  const barW = Math.min(26, Math.max(8, slot * 0.58));

  return (
    <>
      <div className="ch-section-title" style={{ marginTop: 22, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Movimiento por día</span>
        <div style={{ display: "flex", gap: 4 }}>
          {METRICS.map((m) => (
            <button
              key={m.id}
              onClick={() => setMetric(m.id)}
              style={{
                background: metric === m.id ? "var(--gold)" : "var(--surface-2)",
                color: metric === m.id ? "#14150F" : "var(--text-dim)",
                border: "1px solid var(--border)", borderRadius: 999,
                padding: "3px 10px", fontSize: 11, fontWeight: 600,
                fontFamily: "'Inter', sans-serif", cursor: "pointer",
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ch-card" style={{ paddingBottom: 12 }}>
        {data.length === 0 ? (
          <EmptyRow text="Todavía no hay ventas para graficar." />
        ) : (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <span style={{ fontSize: 11.5, color: "var(--text-faint)" }}>Máximo del periodo</span>
              <span className="ch-serif" style={{ fontSize: 16, color: "var(--gold)" }}>{active.fmt(max)}</span>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
              aria-label={`Gráfica de ${active.label.toLowerCase()} por día`}>
              {[0, 0.5, 1].map((t) => (
                <line key={t} x1="0" x2={W} y1={padT + (H - padT - padB) * t} y2={padT + (H - padT - padB) * t}
                  stroke="var(--border)" strokeWidth="1" />
              ))}
              {data.map((d, i) => {
                const v = active.get(d);
                const h = Math.max(2, ((H - padT - padB) * v) / max);
                const x = i * slot + (slot - barW) / 2;
                const y = H - padB - h;
                const isToday = d.date === todayStr;
                return (
                  <g key={d.date}>
                    <title>{`${formatDate(d.date)}: ${active.fmt(v)}`}</title>
                    <rect x={x} y={y} width={barW} height={h} rx="3"
                      fill={isToday ? "var(--gold)" : "var(--gold-dim)"} />
                    <text x={x + barW / 2} y={H - 6} textAnchor="middle"
                      fontSize="8.5" fill={isToday ? "var(--gold)" : "var(--text-faint)"}
                      fontFamily="Inter, sans-serif">
                      {d.date.slice(8, 10)}/{d.date.slice(5, 7)}
                    </text>
                  </g>
                );
              })}
            </svg>
            <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: 2 }}>
              Últimos {data.length} día{data.length === 1 ? "" : "s"} con venta. La barra dorada es hoy.
            </div>
          </>
        )}
      </div>
    </>
  );
}

/* ----------------------------------------------------------------------------
   GENERADOR DE REPORTE
   Un solo botón, un solo archivo: se elige el periodo y sale el Excel con
   todos los pedidos de ese periodo. No se genera nada por venta individual.
---------------------------------------------------------------------------- */
function SalesReportPanel({ customers, orders, dailyStats }) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const monthStart = todayStr.slice(0, 8) + "01";

  const RANGES = [
    { id: "today", label: "Hoy", from: todayStr, to: todayStr, rangeLabel: `Hoy — ${formatDate(todayStr)}` },
    { id: "week", label: "Últimos 7 días", from: daysAgo(6), to: todayStr, rangeLabel: `${formatDate(daysAgo(6))} al ${formatDate(todayStr)}` },
    { id: "month", label: "Este mes", from: monthStart, to: todayStr, rangeLabel: `${formatDate(monthStart)} al ${formatDate(todayStr)}` },
    { id: "all", label: "Todo el historial", from: null, to: null, rangeLabel: "Histórico completo" },
  ];
  const [rangeId, setRangeId] = useState("today");
  const range = RANGES.find((r) => r.id === rangeId);

  const preview = useMemo(
    () => buildSalesReport(customers, orders, { from: range.from, to: range.to }),
    [customers, orders, range.from, range.to]
  );

  return (
    <>
      <div className="ch-section-title" style={{ marginTop: 22 }}>Reporte de ventas</div>
      <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: -6, marginBottom: 8 }}>
        Elige el periodo y descarga un solo archivo con todos los pedidos: producto, precio,
        método de pago, inversión y ganancia.
      </p>
      <div className="ch-card">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
          {RANGES.map((r) => (
            <button
              key={r.id}
              onClick={() => setRangeId(r.id)}
              style={{
                background: rangeId === r.id ? "var(--gold)" : "var(--surface-2)",
                color: rangeId === r.id ? "#14150F" : "var(--text-dim)",
                border: "1px solid var(--border)", borderRadius: 999,
                padding: "6px 12px", fontSize: 12, fontWeight: 600,
                fontFamily: "'Inter', sans-serif", cursor: "pointer",
              }}
            >
              {r.label}
            </button>
          ))}
        </div>

        <Row label="Pedidos en el periodo" value={preview.count} />
        <Row label="Piezas" value={preview.totals.units} />
        <Row label="Venta total" value={formatMoney(preview.totals.revenue)} />
        {preview.totals.credit > 0 && (
          <Row label="Crédito de recompensas aplicado" value={"–" + formatMoney(preview.totals.credit)} />
        )}
        <Row label="Inversión" value={formatMoney(preview.totals.invest)} />
        <Row label="Ganancia estimada" value={formatMoney(preview.totals.profit)} bold />

        {preview.totals.missingCost && (
          <div style={{ fontSize: 11.5, color: "var(--rust)", marginTop: 8, lineHeight: 1.45 }}>
            Hay modelos sin inversión capturada. Esas piezas salen con “—” en el Excel y no suman a la ganancia.
          </div>
        )}

        <button
          className="ch-btn ch-btn-primary ch-btn-block"
          style={{ marginTop: 14 }}
          disabled={preview.count === 0}
          onClick={() => exportSalesReport(customers, orders, { from: range.from, to: range.to, rangeLabel: range.rangeLabel })}
        >
          Descargar reporte en Excel
        </button>
        {preview.count === 0 && (
          <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 8, textAlign: "center" }}>
            No hay ventas confirmadas en este periodo.
          </div>
        )}
      </div>
    </>
  );
}

function AdminStatsTab({ stats, stockLevels, customers, orders }) {
  const [expandedKey, setExpandedKey] = useState(null);
  const dailyStats = useMemo(() => computeDailyStats(customers, orders), [customers, orders]);
  const todayStr = new Date().toISOString().slice(0, 10);

  return (
    <div>
      <div className="ch-section-title" style={{ marginTop: 18 }}>Números globales</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <StatBox label="Clientes" value={stats.totalCustomers} />
        <StatBox label="Ingresos totales" value={formatMoney(stats.totalRevenue)} />
        <StatBox label="Pedidos confirmados" value={stats.totalOrders} />
        <StatBox label="Ticket promedio" value={formatMoney(stats.avgOrderValue)} />
        <StatBox label="LTV promedio / cliente" value={formatMoney(stats.avgLTV)} />
        <StatBox label="Compras / cliente (prom.)" value={stats.avgPurchasesPerCustomer.toFixed(1)} />
        <StatBox label="Piezas por pedido (prom.)" value={stats.avgUnitsPerOrder.toFixed(1)} />
        <StatBox label="Puntos en circulación" value={formatPoints(stats.pointsOutstanding)} />
      </div>

      <SalesChart dailyStats={dailyStats} />

      <SalesReportPanel customers={customers} orders={orders} dailyStats={dailyStats} />

      <div className="ch-section-title" style={{ marginTop: 22 }}>Ventas por día</div>
      <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: -6, marginBottom: 8 }}>
        El día de hoy se actualiza solo, con cada pedido que se confirma o venta manual que se registra.
      </p>
      <div className="ch-card">
        {dailyStats.length === 0 ? (
          <EmptyRow text="Todavía no hay ventas confirmadas." />
        ) : dailyStats.map((day) => (
          <div key={day.date} style={{ padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {formatDate(day.date)}{day.date === todayStr && <span style={{ color: "var(--gold)", fontWeight: 600 }}> · Hoy</span>}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--text-faint)", marginTop: 2 }}>
              <span>
                {day.orders.length} pedido{day.orders.length === 1 ? "" : "s"} · {day.units} pzs · Página {day.appOrders} / WhatsApp {day.waOrders}
                {day.creditUsed > 0 && <span style={{ color: "var(--gold)" }}> · crédito {formatMoney(day.creditUsed)}</span>}
              </span>
              <span style={{ color: "var(--gold)", fontWeight: 600 }}>{formatMoney(day.revenue)}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="ch-section-title" style={{ marginTop: 22 }}>Programa de referidos</div>
      <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: -6, marginBottom: 8 }}>
        Quién está trayendo clientes. Se cuenta cuando el invitado se registra con el enlace y se paga cuando compra.
      </p>
      <div className="ch-card">
        {(() => {
          const rows = customers
            .filter((c) => c.status === "active")
            .map((c) => ({ c, st: computeReferralStats(customers, orders, c.id, 0) }))
            .filter((r) => r.st.registered > 0)
            .sort((a, b) => b.st.purchased - a.st.purchased || b.st.registered - a.st.registered);
          return rows.length === 0 ? (
            <EmptyRow text="Todavía nadie ha traído a un invitado por enlace." />
          ) : rows.map(({ c, st }) => (
            <Row
              key={c.id}
              label={c.name}
              value={`${st.registered} registrado${st.registered === 1 ? "" : "s"} · ${st.purchased} compró · ${formatPoints(st.pointsEarned)} pts`}
            />
          ));
        })()}
      </div>

      <div className="ch-section-title" style={{ marginTop: 22 }}>Inventario con stock bajo</div>
      <div className="ch-card">
        {(() => {
          const low = PRODUCTS
            .map((p) => ({ p, remaining: stockLevels?.[p.id] ?? p.stock }))
            .filter((r) => r.remaining <= 5)
            .sort((a, b) => a.remaining - b.remaining);
          const model = (id) => MODELS.find((m) => m.id === id);
          return low.length === 0 ? (
            <EmptyRow text="Ningún sabor está por agotarse." />
          ) : low.map(({ p, remaining }) => (
            <Row
              key={p.id}
              label={`${model(p.modelId)?.icon || ""} ${model(p.modelId)?.name} — ${p.name}`}
              value={remaining === 0 ? "Agotado" : `${remaining} pzs`}
              bold={remaining === 0}
            />
          ));
        })()}
      </div>

      <div className="ch-section-title" style={{ marginTop: 22 }}>Canal de venta</div>
      <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: -6, marginBottom: 8 }}>
        Qué tan avanzada va la migración de WhatsApp a la página.
      </p>
      <div className="ch-card">
        {(() => {
          const { app, whatsapp } = stats.channelBreakdown;
          const totalOrders = app.orders + whatsapp.orders;
          const pct = (n) => totalOrders > 0 ? Math.round((n / totalOrders) * 100) : 0;
          return (
            <>
              <Row label="Página" value={`${app.orders} pedido${app.orders === 1 ? "" : "s"} (${pct(app.orders)}%) · ${formatMoney(app.revenue)}`} />
              <Row label="WhatsApp (venta manual)" value={`${whatsapp.orders} pedido${whatsapp.orders === 1 ? "" : "s"} (${pct(whatsapp.orders)}%) · ${formatMoney(whatsapp.revenue)}`} />
            </>
          );
        })()}
      </div>

      <div className="ch-section-title" style={{ marginTop: 22 }}>
        Clientes por registrar {stats.provisionalCustomers.length > 0 ? `(${stats.provisionalCustomers.length})` : ""}
      </div>
      <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: -6, marginBottom: 8 }}>
        Compraron por WhatsApp y todavía no crean su cuenta en la página — ya tienen puntos esperándolos.
      </p>
      <div className="ch-card">
        {stats.provisionalCustomers.length === 0 ? (
          <EmptyRow text="No hay cuentas provisionales pendientes de reclamar." />
        ) : stats.provisionalCustomers.map((c) => (
          <Row
            key={c.id}
            label={`${c.name} · ${c.phone} · ${c.totalPurchases} compra${c.totalPurchases === 1 ? "" : "s"}`}
            value={`${formatPoints(c.pointsBalance)} pts`}
          />
        ))}
      </div>

      <div className="ch-section-title" style={{ marginTop: 22 }}>Clientes por valor de vida (LTV)</div>
      <div className="ch-card">
        {stats.topCustomers.length === 0 ? (
          <EmptyRow text="Todavía no hay clientes con compras." />
        ) : stats.topCustomers.map((c, i) => (
          <Row
            key={c.id}
            label={`${i + 1}. ${c.name}${c.status === "provisional" ? " (sin registrar)" : ""} · ${c.totalPurchases} compra${c.totalPurchases === 1 ? "" : "s"} · ${c.membershipLevel}`}
            value={formatMoney(c.totalSpent)}
            bold={i === 0}
          />
        ))}
      </div>

      <div className="ch-section-title" style={{ marginTop: 22 }}>Clientes por nivel de membresía</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {Object.entries(stats.membershipBreakdown).map(([level, count]) => (
          <span key={level} className="ch-tag" style={{ background: "var(--surface-2)", color: "var(--text-dim)" }}>
            {level}: {count}
          </span>
        ))}
      </div>

      <div className="ch-section-title" style={{ marginTop: 22 }}>Modelos más vendidos</div>
      <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: -6, marginBottom: 8 }}>Toca uno para ver quién lo compró.</p>
      <div className="ch-card">
        {stats.modelPopularity.length === 0 ? (
          <EmptyRow text="Aún no hay piezas vendidas registradas." />
        ) : stats.modelPopularity.map((r) => (
          <AdminBreakdownRow
            key={r.model.id}
            rowKey={`model:${r.model.id}`}
            label={`${r.model.icon} ${r.model.name}`}
            qty={r.qty}
            maxQty={stats.maxModelQty}
            color="var(--gold)"
            buyers={r.buyers}
            expandedKey={expandedKey}
            onToggle={setExpandedKey}
          />
        ))}
      </div>

      <div className="ch-section-title" style={{ marginTop: 22 }}>Sabores más vendidos</div>
      <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: -6, marginBottom: 8 }}>Toca uno para ver quién lo compró — útil para detectar patrones y contactar de forma personalizada.</p>
      <div className="ch-card">
        {stats.flavorPopularity.length === 0 ? (
          <EmptyRow text="Aún no hay sabores vendidos registrados." />
        ) : stats.flavorPopularity.map((r) => (
          <AdminBreakdownRow
            key={r.name}
            rowKey={`flavor:${r.name}`}
            label={r.name}
            qty={r.qty}
            maxQty={stats.maxFlavorQty}
            color="var(--green)"
            buyers={r.buyers}
            expandedKey={expandedKey}
            onToggle={setExpandedKey}
          />
        ))}
      </div>

      <p style={{ color: "var(--text-faint)", fontSize: 11.5, marginTop: 18, lineHeight: 1.5 }}>
        Estos reportes se calculan a partir de los mismos datos de clientes y pedidos que ya usa la app.
        Para verlos consolidados de TODOS los clientes (no solo de este navegador) hace falta mover
        clientes/pedidos a una base de datos compartida (backend) — hoy viven solo en memoria de cada sesión.
      </p>
    </div>
  );
}

function AdminManualSaleTab({ customers, stockLevels, onRegisterManualSale }) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [paymentMethod, setPaymentMethod] = useState(PAYMENT_METHODS[0].id);
  const [catalogTab, setCatalogTab] = useState(MODELS[0].id);
  const [manualCart, setManualCart] = useState({}); // { productId: qty }
  const [feedback, setFeedback] = useState(null); // { type: 'success' | 'error', text }

  const phoneMatch = findCustomerByPhone(customers, phone);
  const model = MODELS.find((m) => m.id === catalogTab) || MODELS[0];
  const products = PRODUCTS_BY_MODEL[model.id] || [];

  function changeQty(productId, delta) {
    setManualCart((c) => {
      const current = c[productId] || 0;
      const cap = stockLevels?.[productId] ?? 0;
      const next = delta > 0 ? Math.min(cap, current + delta) : Math.max(0, current + delta);
      const copy = { ...c };
      if (next === 0) delete copy[productId]; else copy[productId] = next;
      return copy;
    });
  }

  const cartList = useMemo(
    () => Object.entries(manualCart).map(([id, qty]) => ({ product: PRODUCTS.find((p) => p.id === id), qty })).filter((i) => i.product && i.qty > 0),
    [manualCart]
  );
  const cartCount = cartList.reduce((s, i) => s + i.qty, 0);
  const pricing = useMemo(() => computeCartPricing(cartList), [cartList]);
  const [saving, setSaving] = useState(false);

  async function submit() {
    setSaving(true);
    const result = await onRegisterManualSale({ phone, name, cartList, paymentMethod });
    setSaving(false);
    if (!result.ok) {
      setFeedback({ type: "error", text: result.error });
      return;
    }
    setFeedback({
      type: "success",
      text: result.isNew
        ? `Venta registrada. Se creó una cuenta provisional (sin registrar) — ya tiene ${formatPoints(result.pointsEarned)} puntos esperándola.`
        : `Venta registrada. Se sumaron ${formatPoints(result.pointsEarned)} puntos a la cuenta existente.`,
    });
    setPhone("");
    setName("");
    setManualCart({});
    setPaymentMethod(PAYMENT_METHODS[0].id);
  }

  return (
    <div>
      <div className="ch-section-title" style={{ marginTop: 18 }}>Registrar venta manual</div>
      <p style={{ color: "var(--text-faint)", fontSize: 12, marginTop: -6, marginBottom: 12 }}>
        Para ventas cerradas por WhatsApp fuera de la página. Descuenta del mismo stock y otorga los mismos
        puntos que un pedido confirmado — así nunca hay dos números de inventario distintos.
      </p>

      <div className="ch-card">
        <div className="ch-input-group">
          <label className="ch-label">Teléfono del cliente</label>
          <input className="ch-input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="55 1234 5678" />
          {phoneMatch && phoneMatch.status === "active" && (
            <div style={{ fontSize: 12, color: "var(--green)", marginTop: 6 }}>
              Cliente existente: {phoneMatch.name} · {formatPoints(phoneMatch.pointsBalance)} pts
            </div>
          )}
          {phoneMatch && phoneMatch.status === "provisional" && (
            <div style={{ fontSize: 12, color: "var(--gold)", marginTop: 6 }}>
              Ya tiene cuenta provisional (sin registrar): {phoneMatch.name} · {formatPoints(phoneMatch.pointsBalance)} pts acumulados
            </div>
          )}
          {phone.trim() && !phoneMatch && (
            <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 6 }}>
              Cliente nuevo — se creará una cuenta provisional (sin registrar) con este teléfono como llave.
            </div>
          )}
        </div>
        <div className="ch-input-group" style={{ marginBottom: 0 }}>
          <label className="ch-label">Nombre</label>
          <input
            className="ch-input"
            value={phoneMatch ? phoneMatch.name : name}
            onChange={(e) => setName(e.target.value)}
            disabled={!!phoneMatch}
            placeholder="Nombre del cliente"
          />
        </div>
      </div>

      <div className="ch-section-title" style={{ marginTop: 18 }}>Método de pago</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {PAYMENT_METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            className={"ch-btn " + (paymentMethod === m.id ? "ch-btn-primary" : "ch-btn-secondary")}
            style={{ flex: "1 1 auto" }}
            onClick={() => setPaymentMethod(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="ch-section-title" style={{ marginTop: 20, marginBottom: 0 }}>Producto(s)</div>
      <div className="ch-model-tabs" style={{ marginTop: 10 }}>
        {MODELS.map((m) => {
          const qtyInModel = PRODUCTS_BY_MODEL[m.id].reduce((s, p) => s + (manualCart[p.id] || 0), 0);
          return (
            <button
              key={m.id}
              className={"ch-model-tab" + (m.id === catalogTab ? " ch-model-tab-active" : "")}
              onClick={() => setCatalogTab(m.id)}
              style={m.available === false ? { opacity: 0.55 } : undefined}
            >
              <span>{m.icon}</span>
              <span>{m.name}</span>
              {qtyInModel > 0 && <span className="ch-model-tab-badge">{qtyInModel}</span>}
            </button>
          );
        })}
      </div>

      <div className="ch-flavor-list">
        {products.map((p) => {
          const qty = manualCart[p.id] || 0;
          const remaining = remainingStock(p, stockLevels);
          const available = model.available !== false && remaining > 0;
          return (
            <div key={p.id} className="ch-flavor-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{p.name}</div>
                {!available ? (
                  <span className="ch-tag ch-tag-unavailable" style={{ marginTop: 4, display: "inline-block" }}>Agotado</span>
                ) : (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="ch-serif" style={{ fontSize: 14, color: "var(--gold)" }}>{formatMoney(p.price)}</span>
                    <span style={{ fontSize: 11, color: "var(--text-faint)" }}>· quedan {remaining}</span>
                  </div>
                )}
              </div>
              {available && (
                <QuantityStepper size="sm" qty={qty} onDecrement={() => changeQty(p.id, -1)} onIncrement={() => qty < remaining && changeQty(p.id, 1)} />
              )}
            </div>
          );
        })}
      </div>

      {cartCount > 0 && (
        <div className="ch-card" style={{ marginTop: 14 }}>
          <div className="ch-section-title" style={{ marginTop: 0 }}>Resumen</div>
          {cartList.map((i) => (
            <Row key={i.product.id} label={`${i.qty} x ${i.product.name}`} value={formatMoney(i.product.price * i.qty)} />
          ))}
          {pricing.savings > 0 && (
            <div style={{ fontSize: 12, color: "var(--green)", marginTop: 4 }}>Ahorro por promo 2x: {formatMoney(pricing.savings)}</div>
          )}
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8, display: "flex", justifyContent: "space-between", fontSize: 14 }}>
            <span style={{ color: "var(--text-dim)" }}>Total</span>
            <span className="ch-serif" style={{ color: "var(--gold)" }}>{formatMoney(pricing.total)}</span>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 4 }}>
            Puntos que ganará: {formatPoints(Math.round(pricing.total * POINTS_PER_PURCHASE_RATE))}
          </div>
        </div>
      )}

      {feedback && (
        <div style={{ marginTop: 12, fontSize: 13, color: feedback.type === "success" ? "var(--green)" : "var(--rust)" }}>
          {feedback.text}
        </div>
      )}

      <button
        className="ch-btn ch-btn-primary ch-btn-block"
        style={{ marginTop: 14, opacity: (!phone.trim() || cartCount === 0 || saving) ? 0.5 : 1 }}
        disabled={!phone.trim() || cartCount === 0 || saving}
        onClick={submit}
      >
        {saving ? "Registrando…" : "Registrar venta"}
      </button>
    </div>
  );
}

/* ============================================================================
   STOCK (reposiciones y correcciones manuales)
   Pensado para que lo use cualquier persona del negocio, no solo quien
   entiende Supabase: botones grandes para sumar cuando llega mercancía, y
   un campo de "número exacto" para cuando se hace un conteo físico y hay
   que corregir. Cada cambio se guarda de inmediato en la tabla `sabores`
   (misma fuente que usa el catálogo y las ventas), así que se refleja para
   cualquiera que tenga la página abierta, no solo en esta sesión.
============================================================================ */
function AdminStockTab({ stockLevels, onSetStock }) {
  const [catalogTab, setCatalogTab] = useState(MODELS[0]?.id);
  const model = MODELS.find((m) => m.id === catalogTab) || MODELS[0];
  const products = PRODUCTS_BY_MODEL[model?.id] || [];
  const totalUnits = useMemo(
    () => PRODUCTS.reduce((s, p) => s + (stockLevels?.[p.id] ?? 0), 0),
    [stockLevels]
  );
  const outOfStockCount = useMemo(
    () => PRODUCTS.filter((p) => (stockLevels?.[p.id] ?? 0) === 0).length,
    [stockLevels]
  );

  return (
    <div>
      <div className="ch-section-title" style={{ marginTop: 18 }}>Ajustar stock</div>
      <p style={{ color: "var(--text-faint)", fontSize: 12, marginTop: -6, marginBottom: 12 }}>
        Usa los botones para sumar en cuanto llegue mercancía nueva, o escribe el número exacto si acabas de
        hacer un conteo físico. Se guarda directo en la base de datos — es el mismo número que ve la página y
        el que descuentan las ventas, no hay otro aparte.
      </p>

      <div style={{ display: "flex", gap: 10, marginBottom: 4 }}>
        <div className="ch-card" style={{ flex: 1, padding: "10px 12px" }}>
          <div style={{ fontSize: 11, color: "var(--text-faint)" }}>Unidades totales</div>
          <div className="ch-serif" style={{ fontSize: 18, marginTop: 2 }}>{totalUnits}</div>
        </div>
        <div className="ch-card" style={{ flex: 1, padding: "10px 12px" }}>
          <div style={{ fontSize: 11, color: "var(--text-faint)" }}>Sabores agotados</div>
          <div className="ch-serif" style={{ fontSize: 18, marginTop: 2, color: outOfStockCount > 0 ? "var(--rust)" : "var(--text)" }}>
            {outOfStockCount}
          </div>
        </div>
      </div>

      <div className="ch-model-tabs" style={{ marginTop: 14 }}>
        {MODELS.map((m) => (
          <button
            key={m.id}
            className={"ch-model-tab" + (m.id === catalogTab ? " ch-model-tab-active" : "")}
            onClick={() => setCatalogTab(m.id)}
            style={m.available === false ? { opacity: 0.55 } : undefined}
          >
            <span>{m.icon}</span>
            <span>{m.name}</span>
          </button>
        ))}
      </div>

      <div className="ch-flavor-list">
        {products.map((p) => (
          <AdminStockRow key={p.id} product={p} stock={stockLevels?.[p.id] ?? 0} onSetStock={onSetStock} />
        ))}
      </div>
    </div>
  );
}

function AdminStockRow({ product, stock, onSetStock }) {
  const [draft, setDraft] = useState(String(stock));
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(null); // { type: 'ok' | 'error', text }

  // Si el número cambia desde afuera (otra pestaña, otra persona, o el
  // propio guardado), el campo de "número exacto" se refresca — así nunca
  // se queda mostrando un valor viejo que ya no es cierto.
  useEffect(() => { setDraft(String(stock)); }, [stock]);

  async function apply(newValue) {
    const clean = Math.max(0, Math.round(Number(newValue) || 0));
    setSaving(true);
    setNote(null);
    const result = await onSetStock(product.id, clean);
    setSaving(false);
    if (result.ok) {
      setNote({ type: "ok", text: "Guardado" });
      setTimeout(() => setNote(null), 1800);
    } else {
      setNote({ type: "error", text: result.error || "No se pudo guardar." });
    }
  }

  const smallBtn = { padding: "6px 10px", fontSize: 12, minWidth: 0 };

  return (
    <div className="ch-flavor-row" style={{ flexWrap: "wrap", rowGap: 8, columnGap: 10 }}>
      <div style={{ flex: "1 1 130px", minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600 }}>{product.name}</div>
        <div style={{ fontSize: 11, marginTop: 2, color: stock === 0 ? "var(--rust)" : "var(--text-faint)" }}>
          {stock === 0 ? "Agotado" : `${stock} en stock`}
          {saving ? " · guardando…" : ""}
        </div>
        {note && (
          <div style={{ fontSize: 11, marginTop: 2, color: note.type === "ok" ? "var(--green)" : "var(--rust)" }}>
            {note.text}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button className="ch-btn ch-btn-secondary" style={smallBtn} disabled={saving || stock === 0} onClick={() => apply(stock - 1)}>−1</button>
        <button className="ch-btn ch-btn-secondary" style={smallBtn} disabled={saving} onClick={() => apply(stock + 1)}>+1</button>
        <button className="ch-btn ch-btn-secondary" style={smallBtn} disabled={saving} onClick={() => apply(stock + 6)}>+6</button>
        <button className="ch-btn ch-btn-secondary" style={smallBtn} disabled={saving} onClick={() => apply(stock + 12)}>+12</button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          className="ch-input"
          type="number"
          min={0}
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{ width: 64, padding: "6px 8px", fontSize: 13 }}
        />
        <button
          className="ch-btn ch-btn-primary"
          style={smallBtn}
          disabled={saving || draft === "" || Number(draft) === stock}
          onClick={() => apply(draft)}
        >
          Guardar
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
   EDITOR DE PRODUCTOS (modelos y sabores)
   Un recuadro por modelo, colapsado por default. Al abrirlo se ve su lista
   de sabores con opción de añadir/eliminar, y arriba el nombre y los
   precios del modelo se editan directo (con botón Guardar). El precio es
   por modelo, no por sabor — así lo pidió el negocio: todos los sabores de
   un mismo modelo cuestan lo mismo.
============================================================================ */
function AdminProductsTab({ onAddModel, onUpdateModel, onDeleteModel, onAddFlavor, onDeleteFlavor }) {
  const [openModelId, setOpenModelId] = useState(null);
  const [showAddModel, setShowAddModel] = useState(false);

  return (
    <div>
      <div className="ch-section-title" style={{ marginTop: 18 }}>Modelos y sabores</div>
      <p style={{ color: "var(--text-faint)", fontSize: 12, marginTop: -6, marginBottom: 12 }}>
        Toca un modelo para ver y editar sus sabores. Los cambios se guardan directo en la base de datos
        (si el catálogo ya viene de Supabase); si sigues en el catálogo de ejemplo, el cambio solo dura
        mientras esta pestaña siga abierta.
      </p>

      {MODELS.map((model) => (
        <AdminModelCard
          key={model.id}
          model={model}
          isOpen={openModelId === model.id}
          onToggle={() => setOpenModelId((id) => (id === model.id ? null : model.id))}
          onUpdateModel={onUpdateModel}
          onDeleteModel={onDeleteModel}
          onAddFlavor={onAddFlavor}
          onDeleteFlavor={onDeleteFlavor}
        />
      ))}

      {showAddModel ? (
        <AddModelForm onAddModel={onAddModel} onDone={() => setShowAddModel(false)} />
      ) : (
        <button
          className="ch-btn ch-btn-secondary"
          style={{ width: "100%", marginTop: 12 }}
          onClick={() => setShowAddModel(true)}
        >
          + Añadir modelo nuevo
        </button>
      )}
    </div>
  );
}

function AdminModelCard({ model, isOpen, onToggle, onUpdateModel, onDeleteModel, onAddFlavor, onDeleteFlavor }) {
  const [editingHeader, setEditingHeader] = useState(false);
  const [name, setName] = useState(model.name);
  const [priceSingle, setPriceSingle] = useState(String(model.priceSingle ?? ""));
  const [priceDuo, setPriceDuo] = useState(String(model.priceDuo ?? ""));
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(null); // { type: 'ok' | 'error', text }
  const [showAddFlavor, setShowAddFlavor] = useState(false);

  async function saveHeader() {
    setSaving(true);
    setNote(null);
    const result = await onUpdateModel(model.id, { name, priceSingle, priceDuo });
    setSaving(false);
    if (result.ok) {
      setEditingHeader(false);
      setNote({ type: "ok", text: result.offline ? "Guardado solo en esta sesión (catálogo de ejemplo)" : "Guardado en la base de datos" });
      setTimeout(() => setNote(null), 2600);
    } else {
      setNote({ type: "error", text: result.error || "No se pudo guardar." });
    }
  }

  async function handleDeleteModel() {
    const ok = window.confirm(`¿Eliminar "${model.name}" y todos sus sabores? Esto no se puede deshacer.`);
    if (!ok) return;
    setSaving(true);
    const result = await onDeleteModel(model.id);
    setSaving(false);
    if (!result.ok) setNote({ type: "error", text: result.error || "No se pudo eliminar." });
  }

  return (
    <div className="ch-card" style={{ marginTop: 10, padding: 0, overflow: "hidden" }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 14px", cursor: "pointer" }}
        onClick={() => !editingHeader && onToggle()}
      >
        <span style={{ fontSize: 18 }}>{model.icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600 }}>{model.name}</div>
          <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
            {model.flavors.length} sabor{model.flavors.length === 1 ? "" : "es"} · ${model.priceSingle} / 2x ${model.priceDuo}
            {model.available === false ? " · pausado" : ""}
          </div>
        </div>
        {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
      </div>

      {isOpen && (
        <div style={{ padding: "0 14px 14px" }}>
          {editingHeader ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
              <input className="ch-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del modelo" />
              <div style={{ display: "flex", gap: 8 }}>
                <input className="ch-input" type="number" value={priceSingle} onChange={(e) => setPriceSingle(e.target.value)} placeholder="Precio 1x" style={{ flex: 1 }} />
                <input className="ch-input" type="number" value={priceDuo} onChange={(e) => setPriceDuo(e.target.value)} placeholder="Precio 2x" style={{ flex: 1 }} />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="ch-btn ch-btn-primary" style={{ flex: 1 }} disabled={saving} onClick={saveHeader}>Guardar</button>
                <button className="ch-btn ch-btn-secondary" style={{ flex: 1 }} disabled={saving} onClick={() => { setEditingHeader(false); setName(model.name); setPriceSingle(String(model.priceSingle ?? "")); setPriceDuo(String(model.priceDuo ?? "")); }}>Cancelar</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button className="ch-btn ch-btn-secondary" style={{ flex: 1, fontSize: 12.5 }} onClick={() => setEditingHeader(true)}>Editar nombre / precio</button>
              <button className="ch-btn ch-btn-secondary" style={{ flex: 1, fontSize: 12.5, color: "var(--rust)" }} disabled={saving} onClick={handleDeleteModel}>Eliminar modelo</button>
            </div>
          )}

          {note && (
            <div style={{ fontSize: 11.5, marginBottom: 10, color: note.type === "ok" ? "var(--green)" : "var(--rust)" }}>
              {note.text}
            </div>
          )}

          <div style={{ fontSize: 11.5, color: "var(--text-faint)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>Sabores</div>
          <div className="ch-flavor-list">
            {model.flavors.map((flavor) => (
              <AdminFlavorRow
                key={flavor.productId || flavor.name}
                modelId={model.id}
                flavor={flavor}
                onDeleteFlavor={onDeleteFlavor}
              />
            ))}
            {model.flavors.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--text-faint)", padding: "8px 0" }}>Este modelo todavía no tiene sabores.</div>
            )}
          </div>

          {showAddFlavor ? (
            <AddFlavorForm modelId={model.id} onAddFlavor={onAddFlavor} onDone={() => setShowAddFlavor(false)} />
          ) : (
            <button className="ch-btn ch-btn-secondary" style={{ width: "100%", marginTop: 8, fontSize: 12.5 }} onClick={() => setShowAddFlavor(true)}>
              + Añadir sabor
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AdminFlavorRow({ modelId, flavor, onDeleteFlavor }) {
  const [busy, setBusy] = useState(false);
  const productId = flavor.productId || buildProductId(modelId, flavor, 0);

  async function handleDelete() {
    const ok = window.confirm(`¿Eliminar el sabor "${flavor.name}"?`);
    if (!ok) return;
    setBusy(true);
    const result = await onDeleteFlavor(productId);
    setBusy(false);
    if (!result.ok) alert(result.error || "No se pudo eliminar.");
  }

  return (
    <div className="ch-flavor-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5 }}>{flavor.name}</div>
        <div style={{ fontSize: 11, color: "var(--text-faint)" }}>{flavor.stock} en stock</div>
      </div>
      <button className="ch-btn ch-btn-secondary" style={{ padding: "6px 10px", fontSize: 12, color: "var(--rust)" }} disabled={busy} onClick={handleDelete}>
        Eliminar
      </button>
    </div>
  );
}

function AddFlavorForm({ modelId, onAddFlavor, onDone }) {
  const [name, setName] = useState("");
  const [stock, setStock] = useState("0");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setSaving(true);
    setError(null);
    const result = await onAddFlavor(modelId, { name, stock });
    setSaving(false);
    if (result.ok) onDone();
    else setError(result.error || "No se pudo agregar.");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, padding: 10, background: "var(--surface-2)", borderRadius: 10 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input className="ch-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del sabor" style={{ flex: 2 }} />
        <input className="ch-input" type="number" min={0} value={stock} onChange={(e) => setStock(e.target.value)} placeholder="Stock inicial" style={{ flex: 1 }} />
      </div>
      {error && <div style={{ fontSize: 11.5, color: "var(--rust)" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="ch-btn ch-btn-primary" style={{ flex: 1, fontSize: 12.5 }} disabled={saving || !name.trim()} onClick={submit}>Guardar sabor</button>
        <button className="ch-btn ch-btn-secondary" style={{ flex: 1, fontSize: 12.5 }} disabled={saving} onClick={onDone}>Cancelar</button>
      </div>
    </div>
  );
}

function AddModelForm({ onAddModel, onDone }) {
  const [name, setName] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [priceSingle, setPriceSingle] = useState("");
  const [priceDuo, setPriceDuo] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setSaving(true);
    setError(null);
    const result = await onAddModel({ name, subtitle, priceSingle, priceDuo });
    setSaving(false);
    if (result.ok) onDone();
    else setError(result.error || "No se pudo agregar.");
  }

  return (
    <div className="ch-card" style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600 }}>Nuevo modelo</div>
      <input className="ch-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre (ej. WAX)" />
      <input className="ch-input" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="Subtítulo (ej. Dab Pen)" />
      <div style={{ display: "flex", gap: 8 }}>
        <input className="ch-input" type="number" value={priceSingle} onChange={(e) => setPriceSingle(e.target.value)} placeholder="Precio 1x" style={{ flex: 1 }} />
        <input className="ch-input" type="number" value={priceDuo} onChange={(e) => setPriceDuo(e.target.value)} placeholder="Precio 2x" style={{ flex: 1 }} />
      </div>
      {error && <div style={{ fontSize: 11.5, color: "var(--rust)" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="ch-btn ch-btn-primary" style={{ flex: 1 }} disabled={saving || !name.trim()} onClick={submit}>Crear modelo</button>
        <button className="ch-btn ch-btn-secondary" style={{ flex: 1 }} disabled={saving} onClick={onDone}>Cancelar</button>
      </div>
    </div>
  );
}

/* ============================================================================
   PUERTA DE ADMINISTRADOR
   Pantalla mínima, sin logo de cliente ni menú, para que quien llega aquí
   sepa que salió del recorrido normal de la tienda. Solo pide el código.
============================================================================ */
function AdminGateView({ onSuccess, onCancel }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);
  const [checking, setChecking] = useState(false);

  async function submit(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!email.trim() || !password || checking) return;
    setChecking(true);
    setError("");
    const result = await signInAdmin(email.trim(), password);
    setChecking(false);
    if (result.ok) {
      onSuccess();
      return;
    }
    setError(result.error || "No se pudo iniciar sesión.");
    setShake(true);
    window.setTimeout(() => setShake(false), 400);
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, background: "var(--bg)" }}>
      <style>{`@keyframes ch-shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-6px)} 75%{transform:translateX(6px)} }`}</style>
      <div style={{ width: "100%", maxWidth: 320, animation: shake ? "ch-shake .35s" : "none" }}>
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <LogoMark style={{ margin: "0 auto 14px" }} />
          <div className="ch-serif" style={{ fontSize: 19 }}>Acceso de administrador</div>
          <div style={{ fontSize: 12.5, color: "var(--text-faint)", marginTop: 4 }}>Solo para dueños y personal autorizado.</div>
        </div>
        <div onKeyDown={(e) => { if (e.key === "Enter") submit(e); }}>
          <div className="ch-input-group">
            <label className="ch-label">Correo</label>
            <input
              className="ch-input"
              type="email"
              autoFocus
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(""); }}
            />
          </div>
          <div className="ch-input-group">
            <label className="ch-label">Contraseña</label>
            <input
              className="ch-input"
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(""); }}
            />
          </div>
          {error && <div style={{ color: "var(--rust)", fontSize: 12.5, marginTop: -6, marginBottom: 12 }}>{error}</div>}
          <button className="ch-btn ch-btn-primary ch-btn-block" type="button" disabled={checking} onClick={submit}>
            {checking ? "Verificando…" : "Entrar"}
          </button>
          <button className="ch-btn ch-btn-ghost ch-btn-block" type="button" style={{ marginTop: 10 }} disabled={checking} onClick={onCancel}>Volver a la tienda</button>
        </div>
      </div>
    </div>
  );
}

function AdminView({ customers, orders, stockLevels, onConfirmOrder, onCancelOrder, onUpdateOrderItemQty, onRegisterManualSale, onSetStock, catalogVersion, onAddModel, onUpdateModel, onDeleteModel, onAddFlavor, onDeleteFlavor, onExit, onRefreshOrders, soundOn, onToggleSound, ordersLoading, rewardsToDeliver, onMarkRewardDelivered }) {
  const [tab, setTab] = useState("pedidos");
  const stats = useMemo(() => computeAdminStats(customers, orders), [customers, orders]);

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
        <div>
          <h1 className="ch-serif" style={{ fontSize: 24 }}>Panel de administrador</h1>
          <p style={{ color: "var(--text-dim)", fontSize: 13.5, marginTop: 4 }}>
            Pedidos, comportamiento y valor de vida (LTV) de tus clientes.
          </p>
        </div>
        <button
          onClick={onExit}
          style={{ flexShrink: 0, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, padding: "8px 12px", fontSize: 12.5, color: "var(--text-dim)", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontFamily: "'Inter', sans-serif" }}
        >
          <LogOut size={14} /> Salir
        </button>
      </div>
      <div className="ch-tag ch-tag-unavailable" style={{ marginTop: 10, display: "inline-block" }}>
        Solo para administradores — datos de la sesión actual
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 18, overflowX: "auto", paddingBottom: 4, WebkitOverflowScrolling: "touch" }}>
        <button
          className={"ch-btn " + (tab === "pedidos" ? "ch-btn-primary" : "ch-btn-secondary")}
          style={{ flex: "0 0 auto", padding: "11px 16px", fontSize: 13 }}
          onClick={() => setTab("pedidos")}
        >
          Pedidos{stats.pendingOrders.length > 0 ? ` (${stats.pendingOrders.length})` : ""}
        </button>
        <button
          className={"ch-btn " + (tab === "venta" ? "ch-btn-primary" : "ch-btn-secondary")}
          style={{ flex: "0 0 auto", padding: "11px 16px", fontSize: 13 }}
          onClick={() => setTab("venta")}
        >
          Venta manual
        </button>
        <button
          className={"ch-btn " + (tab === "stock" ? "ch-btn-primary" : "ch-btn-secondary")}
          style={{ flex: "0 0 auto", padding: "11px 16px", fontSize: 13 }}
          onClick={() => setTab("stock")}
        >
          Stock
        </button>
        <button
          className={"ch-btn " + (tab === "productos" ? "ch-btn-primary" : "ch-btn-secondary")}
          style={{ flex: "0 0 auto", padding: "11px 16px", fontSize: 13 }}
          onClick={() => setTab("productos")}
        >
          Productos
        </button>
        <button
          className={"ch-btn " + (tab === "estadisticas" ? "ch-btn-primary" : "ch-btn-secondary")}
          style={{ flex: "0 0 auto", padding: "11px 16px", fontSize: 13 }}
          onClick={() => setTab("estadisticas")}
        >
          Estadísticas
        </button>
      </div>

      {tab === "pedidos" ? (
        <AdminOrdersTab
          stats={stats}
          customers={customers}
          onConfirmOrder={onConfirmOrder}
          onCancelOrder={onCancelOrder}
          onUpdateOrderItemQty={onUpdateOrderItemQty}
          onRefresh={onRefreshOrders}
          soundOn={soundOn}
          onToggleSound={onToggleSound}
          refreshing={ordersLoading}
          rewardsToDeliver={rewardsToDeliver}
          onMarkRewardDelivered={onMarkRewardDelivered}
        />
      ) : tab === "venta" ? (
        <AdminManualSaleTab
          customers={customers}
          stockLevels={stockLevels}
          onRegisterManualSale={onRegisterManualSale}
        />
      ) : tab === "stock" ? (
        <AdminStockTab stockLevels={stockLevels} onSetStock={onSetStock} />
      ) : tab === "productos" ? (
        <AdminProductsTab
          key={catalogVersion}
          onAddModel={onAddModel}
          onUpdateModel={onUpdateModel}
          onDeleteModel={onDeleteModel}
          onAddFlavor={onAddFlavor}
          onDeleteFlavor={onDeleteFlavor}
        />
      ) : (
        <AdminStatsTab stats={stats} stockLevels={stockLevels} customers={customers} orders={orders} />
      )}
    </div>
  );
}

/* ============================================================================
   NOTA DE ARQUITECTURA (para el resumen de entrega, no se ejecuta)
   /services previstos: authService, customerService, orderService,
   rewardService, redemptionService, referralService, promotionService.
   Cada uno hoy lee/escribe sobre el estado de React de este archivo;
   migrar a backend significa reemplazar esas funciones por llamadas
   fetch/SDK sin tocar los componentes de UI.
============================================================================ */
