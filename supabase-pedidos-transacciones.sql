-- Ejecutar una sola vez en Supabase → SQL Editor.
-- Crea las tablas que confirmOrder / registerManualSale necesitan para
-- guardar de verdad los pedidos confirmados y el historial de puntos
-- (hasta ahora vivían solo en memoria del navegador y se perdían al
-- recargar la página).

create table if not exists pedidos (
  id bigint generated always as identity primary key,
  cliente_id bigint not null references clientes(id) on delete cascade,
  status text not null default 'Completado',
  items jsonb not null,
  subtotal numeric not null default 0,
  credit_used numeric not null default 0,
  total numeric not null default 0,
  points_earned integer not null default 0,
  origin text not null default 'app',       -- 'app' | 'whatsapp'
  payment_method text default '',
  address text default '',
  reference text default '',
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table if not exists transacciones (
  id bigint generated always as identity primary key,
  cliente_id bigint not null references clientes(id) on delete cascade,
  type text not null default 'purchase',
  amount integer not null default 0,
  description text default '',
  related_order_id bigint references pedidos(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists pedidos_cliente_id_idx on pedidos(cliente_id);
create index if not exists transacciones_cliente_id_idx on transacciones(cliente_id);

alter table pedidos enable row level security;
alter table transacciones enable row level security;

-- OJO — mismo nivel de acceso que ya tienen hoy `modelos` y `sabores`: se
-- permite leer/escribir con la llave anon (pública) para que el panel de
-- administrador, que NO inicia sesión de verdad en Supabase, pueda seguir
-- funcionando tal cual. Esto es exactamente la brecha que se explica en la
-- respuesta: cualquiera que abra las herramientas de desarrollador y use esa
-- misma llave (que ya viaja en el JS de la página) puede leer o modificar
-- pedidos y puntos directo por la API de Supabase, sin pasar por el código
-- ni por el código de administrador. Ver la sección de seguridad de la
-- respuesta para la forma correcta de cerrar esto antes de manejar dinero
-- real de más volumen.
create policy "anon puede leer pedidos" on pedidos for select using (true);
create policy "anon puede insertar pedidos" on pedidos for insert with check (true);
create policy "anon puede leer transacciones" on transacciones for select using (true);
create policy "anon puede insertar transacciones" on transacciones for insert with check (true);
