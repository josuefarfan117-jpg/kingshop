import { supabase } from "./supabaseClient.js";

// Emoji genérico de respaldo — se usa solo si un modelo todavía no tiene foto
// (columna `image_url` vacía en la tabla `modelos`).
const FALLBACK_ICON = "💨";

/**
 * Lee `modelos` + `sabores` + `rewards` de Supabase y regresa los datos ya
 * transformados al mismo formato que antes traía el catálogo de ejemplo
 * (MODELS / REWARDS), para que el resto de la app no tenga que cambiar cómo
 * los usa.
 *
 * Si algo falla (sin internet, tablas vacías, etc.), regresa null — quien
 * llama a esta función decide qué hacer en ese caso (por ahora: se queda
 * con el catálogo de ejemplo, para que la app nunca se quede en blanco).
 */
export async function fetchCatalogFromSupabase() {
  try {
    const [modelosRes, saboresRes, rewardsRes] = await Promise.all([
      supabase.from("modelos").select("*").order("sort_order", { ascending: true }),
      supabase.from("sabores").select("*"),
      supabase.from("rewards").select("*").eq("active", true),
    ]);

    if (modelosRes.error) throw modelosRes.error;
    if (saboresRes.error) throw saboresRes.error;
    if (rewardsRes.error) throw rewardsRes.error;

    const modelos = modelosRes.data || [];
    const sabores = saboresRes.data || [];
    const rewardsRows = rewardsRes.data || [];

    if (modelos.length === 0) {
      // Tabla `modelos` vacía todavía — mejor no reemplazar el catálogo de
      // ejemplo con una tienda vacía.
      console.warn("La tabla 'modelos' está vacía en Supabase, se usa el catálogo de ejemplo por ahora.");
      return null;
    }

    const saboresPorModelo = sabores.reduce((acc, s) => {
      (acc[s.model_id] = acc[s.model_id] || []).push(s);
      return acc;
    }, {});

    const models = modelos.map((m) => ({
      id: `m_${m.id}`,
      dbId: m.id,
      name: m.name,
      subtitle: m.subtitle || "",
      icon: FALLBACK_ICON,
      referenceImage: m.image_url || null,
      priceSingle: m.price_single,
      priceDuo: m.price_duo,
      available: m.active !== false,
      specs: [],
      flavors: (saboresPorModelo[m.id] || []).map((s) => ({
        name: s.name,
        stock: s.stock,
        productId: `f_${s.id}`,
        dbId: s.id,
      })),
    }));

    const rewards = rewardsRows.map((r) => ({
      id: `r_${r.id}`,
      dbId: r.id,
      name: r.name,
      description: r.description || "",
      pointsCost: r.points_cost,
      category: r.category,
      active: r.active !== false,
      stock: r.stock,
      image: r.image || "cash",
      creditValue: typeof r.credit_value === "number" ? r.credit_value : undefined,
      giftBrand: r.gift_brand || undefined,
    }));

    return { models, rewards };
  } catch (err) {
    console.error("No se pudo cargar el catálogo desde Supabase:", err);
    return null;
  }
}
