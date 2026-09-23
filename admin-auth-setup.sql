-- Ejecutar en Supabase → SQL Editor, DESPUÉS de crear tu usuario de
-- administrador en Authentication → Users → "Add user" (correo + contraseña
-- reales, tipo tucorreo@thekingshop.com.mx). Copia el UUID que te muestra
-- esa pantalla (columna "User UID") y pégalo abajo donde dice
-- 'PEGA-AQUI-EL-UUID'.

-- 1) Tabla de administradores: nadie puede leerla ni escribirla directo,
--    solo la función de abajo (que corre con permisos elevados) puede
--    consultarla para responder true/false.
create table if not exists admins (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);
alter table admins enable row level security;
-- Sin políticas de select/insert para nadie: la tabla queda cerrada por
-- completo desde el navegador, tal como admin_config.

-- 2) Función que el panel usa para confirmar "¿la persona que acaba de
--    iniciar sesión es administrador?" — la misma idea que ya usabas con
--    verify_admin_code, ahora contra una cuenta real en vez de un código.
create or replace function is_current_user_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from admins where id = auth.uid());
$$;
grant execute on function is_current_user_admin() to anon, authenticated;

-- 3) Dar de alta a tu cuenta como administradora (una sola vez por persona
--    del equipo que deba entrar al panel).
insert into admins (id, email) values ('PEGA-AQUI-EL-UUID', 'tucorreo@thekingshop.com.mx');

-- ============================================================================
-- 4) CERRAR LAS ESCRITURAS QUE HOY ACEPTA CUALQUIERA CON LA LLAVE ANON
-- Revisa primero en Table Editor → (cada tabla) → Policies qué políticas de
-- INSERT/UPDATE/DELETE ya existen ahí con "true" sin condición, y bórralas —
-- si no las borras, estas nuevas se suman mas no las reemplazan y el hueco
-- sigue abierto. Los nombres de política de abajo son nuevos para no chocar
-- con los que ya tengas.
-- ============================================================================

-- Catálogo (modelos, sabores, rewards): cualquiera puede LEER (así carga la
-- tienda para un visitante sin cuenta), pero solo un administrador puede
-- escribir.
create policy "solo admin escribe modelos" on modelos for all
  using (is_current_user_admin()) with check (is_current_user_admin());
create policy "solo admin escribe sabores" on sabores for all
  using (is_current_user_admin()) with check (is_current_user_admin());
create policy "solo admin escribe rewards" on rewards for all
  using (is_current_user_admin()) with check (is_current_user_admin());

-- Pedidos y transacciones: los crea y actualiza el panel de admin
-- (confirmOrder / registerManualSale corren con la sesión del administrador
-- una vez que inició sesión de verdad). Un cliente puede leer solo sus
-- propios pedidos/transacciones; el admin puede leer y escribir todo.
create policy "admin lee y escribe pedidos" on pedidos for all
  using (is_current_user_admin()) with check (is_current_user_admin());
create policy "cliente lee sus propios pedidos" on pedidos for select
  using (cliente_id in (select id from clientes where user_id = auth.uid()));

create policy "admin lee y escribe transacciones" on transacciones for all
  using (is_current_user_admin()) with check (is_current_user_admin());
create policy "cliente lee sus propias transacciones" on transacciones for select
  using (cliente_id in (select id from clientes where user_id = auth.uid()));

-- Clientes: cada quien lee su propio renglón (esto seguramente ya lo tienes
-- de cuando se conectó el login de clientes; si te marca "la política ya
-- existe" ignóralo). Para escribir: el propio cliente puede crear su
-- registro al darse de alta y reclamar una cuenta provisional con su mismo
-- teléfono; el admin puede crear/editar cualquier renglón (ventas manuales,
-- ajuste de puntos).
create policy "admin lee y escribe clientes" on clientes for all
  using (is_current_user_admin()) with check (is_current_user_admin());
create policy "cliente crea su propio registro" on clientes for insert
  with check (auth.uid() = user_id);
create policy "cliente reclama cuenta provisional por telefono" on clientes for update
  using (user_id is null or user_id = auth.uid())
  with check (user_id = auth.uid());

-- IMPORTANTE: prueba primero en local (npm run dev) con tu cuenta de
-- administrador y con una cuenta de cliente de prueba antes de dar esto por
-- terminado — activar RLS de más aprieta el candado hasta dejar a alguien
-- afuera sin querer (por ejemplo, si el nombre real de alguna columna o
-- tabla no es exactamente el que aquí se supone). Si algo deja de guardar
-- después de correr esto, dime exactamente qué pantalla y qué error da la
-- consola del navegador, y lo ajustamos.
