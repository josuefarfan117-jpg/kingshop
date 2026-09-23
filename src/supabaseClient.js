import { createClient } from "@supabase/supabase-js";

// Estas dos variables se leen del archivo .env (en tu computadora) o de las
// "Environment Variables" que configures en Vercel al publicar la página.
// Nunca pongas aquí directamente la URL o la llave — así puedes cambiarlas
// sin tocar el código, y sin exponerlas si compartes este archivo.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    "Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY. Revisa tu archivo .env."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
