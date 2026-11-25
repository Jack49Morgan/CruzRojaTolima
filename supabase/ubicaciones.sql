-- SAT Tolima: ubicación en vivo del equipo (personas) y de los vehículos.
-- Pegue todo este archivo en Supabase > SQL Editor > New query y pulse "Run". Se puede correr más de una vez.
--
-- Solo las cuentas del equipo (sesión iniciada) ven las posiciones. Nadie escribe en las tablas directamente:
--   * una persona comparte su posición desde el tablero con compartir_ubicacion() y la borra con dejar_de_compartir();
--   * un vehículo (OwnTracks / Traccar Client) envía a la función "ubicacion", que revisa su clave de dispositivo.
-- Cada posición lleva la hora en que el GPS la tomó (no la de llegada), así lo enviado después de estar
-- sin señal queda en su sitio del recorrido. Se guardan solo las últimas 24 horas.

create extension if not exists pgcrypto with schema extensions;

-- Vehículos o celulares fijos que envían su posición con una clave propia (ver nuevo_dispositivo() abajo).
create table if not exists public.dispositivos (
  id         bigint generated always as identity primary key,
  nombre     text not null,                        -- "Ambulancia 2 - Ibagué"
  tipo       text not null default 'vehiculo',     -- vehiculo | persona | servidor (un servidor Traccar que reenvía varios GPS)
  clave_hash text not null unique,                 -- sha256 de la clave; la clave misma no se guarda
  activo     boolean not null default true,
  creado     timestamptz not null default now()
);
alter table public.dispositivos enable row level security;
-- sin políticas: la página no puede leer las claves

-- Última posición de cada persona o vehículo (una fila por cada uno). El mapa escucha esta tabla en vivo.
create table if not exists public.ubicaciones (
  clave       text primary key,                    -- "u:<id de la cuenta>", "d:<id del dispositivo>" o "t:<id del servidor>:<GPS>"
  tipo        text not null,                       -- persona | vehiculo
  nombre      text not null,
  lat         double precision not null,
  lon         double precision not null,
  precision_m real,                                -- radio de incertidumbre del GPS, en metros
  velocidad   real,                                -- km/h
  rumbo       real,                                -- grados, 0 = norte
  bateria     real,                                -- % de batería del celular
  fuente      text,                                -- navegador | owntracks | traccar | traccar-servidor
  usuario     uuid,                                -- cuenta del equipo, si la envía una persona desde el tablero
  creado      timestamptz not null default now()   -- hora de la posición
);

-- Recorrido de las últimas 24 h (se llena solo desde la tabla anterior).
create table if not exists public.ubicaciones_recorrido (
  id     bigint generated always as identity primary key,
  clave  text not null,
  lat    double precision not null,
  lon    double precision not null,
  creado timestamptz not null default now()
);
create index if not exists ubicaciones_recorrido_clave on public.ubicaciones_recorrido(clave, creado);
create index if not exists ubicaciones_recorrido_creado on public.ubicaciones_recorrido(creado);

alter table public.ubicaciones           enable row level security;
alter table public.ubicaciones_recorrido enable row level security;
drop policy if exists "equipo lee" on public.ubicaciones;
drop policy if exists "equipo lee" on public.ubicaciones_recorrido;
create policy "equipo lee" on public.ubicaciones           for select to authenticated using (true);
create policy "equipo lee" on public.ubicaciones_recorrido for select to authenticated using (true);
grant usage on schema public to authenticated;
grant select on public.ubicaciones, public.ubicaciones_recorrido to authenticated;
revoke all on public.ubicaciones, public.ubicaciones_recorrido, public.dispositivos from anon;

-- Cada posición nueva se agrega al recorrido, y de paso se borra lo que tenga más de 24 h.
create or replace function public.ubicaciones_al_recorrido() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.ubicaciones_recorrido (clave, lat, lon, creado) values (new.clave, new.lat, new.lon, new.creado);
  delete from public.ubicaciones_recorrido where creado < now() - interval '24 hours';
  delete from public.ubicaciones where creado < now() - interval '24 hours';
  return new;
end $$;
drop trigger if exists ubicaciones_al_recorrido on public.ubicaciones;
create trigger ubicaciones_al_recorrido after insert or update on public.ubicaciones
  for each row execute function public.ubicaciones_al_recorrido();

-- Una persona del equipo comparte su posición (solo la suya: la clave sale de su sesión).
-- "momento" es la hora en que el celular tomó la posición: si estuvo sin señal, el tablero envía después
-- las posiciones guardadas con su hora real; las que son más viejas que la que ya está en el mapa van solo al recorrido.
create or replace function public.compartir_ubicacion(lat double precision, lon double precision,
  precision_m real default null, velocidad real default null, rumbo real default null,
  bateria real default null, nombre text default null, momento timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare uid uuid := auth.uid(); t timestamptz := least(coalesce(momento, now()), now()); k text;
begin
  if uid is null then raise exception 'Inicie sesión para compartir su ubicación'; end if;
  if lat not between -90 and 90 or lon not between -180 and 180 then raise exception 'Coordenadas inválidas'; end if;
  if t < now() - interval '24 hours' then return; end if;
  k := 'u:' || uid;
  if exists (select 1 from public.ubicaciones where clave = k and creado > t) then
    insert into public.ubicaciones_recorrido (clave, lat, lon, creado) values (k, compartir_ubicacion.lat, compartir_ubicacion.lon, t);
    return;
  end if;
  insert into public.ubicaciones (clave, tipo, nombre, lat, lon, precision_m, velocidad, rumbo, bateria, fuente, usuario, creado)
  values (k, 'persona',
    coalesce(nullif(left(trim(compartir_ubicacion.nombre), 40), ''), (select split_part(email, '@', 1) from auth.users where id = uid), 'Equipo'),
    compartir_ubicacion.lat, compartir_ubicacion.lon, compartir_ubicacion.precision_m, compartir_ubicacion.velocidad,
    compartir_ubicacion.rumbo, compartir_ubicacion.bateria, 'navegador', uid, t)
  on conflict (clave) do update set nombre = excluded.nombre, lat = excluded.lat, lon = excluded.lon,
    precision_m = excluded.precision_m, velocidad = excluded.velocidad, rumbo = excluded.rumbo,
    bateria = excluded.bateria, creado = excluded.creado;
end $$;
-- (la versión anterior, sin "momento", se reemplaza)
drop function if exists public.compartir_ubicacion(double precision, double precision, real, real, real, real, text);

-- "Dejar de compartir": borra la posición y el recorrido de esa persona.
create or replace function public.dejar_de_compartir() returns void
language sql security definer set search_path = public as $$
  delete from public.ubicaciones_recorrido where clave = 'u:' || auth.uid();
  delete from public.ubicaciones where clave = 'u:' || auth.uid();
$$;

revoke all on function public.compartir_ubicacion(double precision, double precision, real, real, real, real, text, timestamptz) from public, anon;
revoke all on function public.dejar_de_compartir() from public, anon;
revoke all on function public.ubicaciones_al_recorrido() from public, anon, authenticated;
grant execute on function public.compartir_ubicacion(double precision, double precision, real, real, real, real, text, timestamptz) to authenticated;
grant execute on function public.dejar_de_compartir() to authenticated;

-- Crear un dispositivo (vehículo). Se corre aquí en el SQL Editor; devuelve la clave UNA sola vez:
--   select * from nuevo_dispositivo('Ambulancia 2 - Ibagué');
--   select * from nuevo_dispositivo('Celular de guardia', 'persona');
--   select * from nuevo_dispositivo('Servidor Traccar', 'servidor');   -- reenvía todos los GPS de vehículo que tenga
-- Para desactivarlo:  update dispositivos set activo = false where nombre = 'Ambulancia 2 - Ibagué';
-- Para ver los que hay: select id, nombre, tipo, activo, creado from dispositivos;
create or replace function public.nuevo_dispositivo(nombre text, tipo text default 'vehiculo')
returns table (dispositivo text, clave text) language plpgsql security definer set search_path = public, extensions as $$
declare k text := encode(extensions.gen_random_bytes(18), 'hex');
begin
  if tipo not in ('vehiculo', 'persona', 'servidor') then raise exception 'tipo debe ser vehiculo, persona o servidor'; end if;
  insert into public.dispositivos (nombre, tipo, clave_hash)
  values (nuevo_dispositivo.nombre, nuevo_dispositivo.tipo, encode(extensions.digest(k, 'sha256'), 'hex'));
  return query select nuevo_dispositivo.nombre, k;
end $$;
revoke all on function public.nuevo_dispositivo(text, text) from public, anon, authenticated;

-- Nombre que el equipo le pone a cada vehículo desde el mapa ("Móvil 20"). Manda sobre el nombre que trae el
-- dispositivo o el servidor Traccar. Solo para vehículos/dispositivos: cada persona elige su propio nombre.
create table if not exists public.ubicaciones_nombres (
  clave       text primary key,
  nombre      text not null,
  actualizado timestamptz not null default now()
);
alter table public.ubicaciones_nombres enable row level security;
drop policy if exists "equipo lee" on public.ubicaciones_nombres;
create policy "equipo lee" on public.ubicaciones_nombres for select to authenticated using (true);
grant select on public.ubicaciones_nombres to authenticated;

create or replace function public.renombrar_ubicacion(clave text, nombre text) returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare n text := left(trim(renombrar_ubicacion.nombre), 40);
begin
  if auth.uid() is null then raise exception 'Inicie sesión para cambiar el nombre'; end if;
  if renombrar_ubicacion.clave not like 'd:%' and renombrar_ubicacion.clave not like 't:%' then
    raise exception 'Solo se puede cambiar el nombre de un vehículo o dispositivo'; end if;
  if coalesce(n, '') = '' then raise exception 'Escriba un nombre'; end if;
  insert into public.ubicaciones_nombres (clave, nombre) values (renombrar_ubicacion.clave, n)
  on conflict (clave) do update set nombre = excluded.nombre, actualizado = now();
  update public.ubicaciones set nombre = n where clave = renombrar_ubicacion.clave;
  if renombrar_ubicacion.clave like 'd:%' then
    update public.dispositivos set nombre = n where id::text = substr(renombrar_ubicacion.clave, 3);
  end if;
end $$;
revoke all on function public.renombrar_ubicacion(text, text) from public, anon;
grant execute on function public.renombrar_ubicacion(text, text) to authenticated;

-- Avisos en vivo al mapa.
do $$ begin
  alter publication supabase_realtime add table public.ubicaciones;
exception when duplicate_object then null; end $$;
