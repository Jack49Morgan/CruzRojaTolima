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
-- clave del vehículo guardada para su código QR (solo se lee con vehiculo_qr(), con sesión del equipo)
alter table public.dispositivos add column if not exists clave_qr text;
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
  if tg_op = 'UPDATE' and new.creado = old.creado and new.lat = old.lat and new.lon = old.lon then return new; end if;
  insert into public.ubicaciones_recorrido (clave, lat, lon, creado) values (new.clave, new.lat, new.lon, new.creado);
  delete from public.ubicaciones_recorrido where creado < now() - interval '24 hours';
  delete from public.ubicaciones where creado < now() - interval '24 hours';
  return new;
end $$;
drop trigger if exists ubicaciones_al_recorrido on public.ubicaciones;
create trigger ubicaciones_al_recorrido after insert or update on public.ubicaciones
  for each row execute function public.ubicaciones_al_recorrido();

-- Kilometraje: se suma con cada posición nueva y NO se borra a las 24 h.
-- Filtra el temblor del GPS (movimientos más cortos que 30 m o que la precisión) y los saltos imposibles
-- (más de 180 km/h entre dos posiciones). Si el rastreador envía su propio odómetro (OBD, por Traccar), se usa ese.
alter table public.ubicaciones add column if not exists odometro_km double precision;   -- odómetro que envía el rastreador
alter table public.ubicaciones add column if not exists km_hoy real;                     -- calculado aquí
alter table public.ubicaciones add column if not exists km_total double precision;       -- calculado aquí

create table if not exists public.kilometraje (
  clave        text primary key,
  km_gps       double precision not null default 0,   -- km sumados con el GPS desde que se empezó a seguir
  base_km      double precision,                      -- lectura del odómetro del vehículo que puso el equipo…
  base_km_gps  double precision,                      -- …y cuánto llevaba km_gps en ese momento
  base_en      timestamptz,
  dia          date,                                  -- día (hora Colombia) de km_hoy
  km_hoy       double precision not null default 0,
  odo_km       double precision,                      -- último odómetro enviado por el rastreador
  odo_dia_km   double precision,                      -- odómetro del rastreador al empezar el día
  lat          double precision,                      -- último punto aceptado (ancla)
  lon          double precision,
  t            timestamptz,
  saltos       int not null default 0,
  actualizado  timestamptz not null default now()
);
alter table public.kilometraje enable row level security;
drop policy if exists "equipo lee" on public.kilometraje;
create policy "equipo lee" on public.kilometraje for select to authenticated using (true);
grant select on public.kilometraje to authenticated;
revoke all on public.kilometraje from anon;

create or replace function public.km_mostrar(k public.kilometraje) returns double precision language sql immutable as $$
  select case when k.odo_km is not null then k.odo_km
              when k.base_km is not null then k.base_km + (k.km_gps - coalesce(k.base_km_gps, 0))
              else k.km_gps end;
$$;

create or replace function public.ubicaciones_km() returns trigger
language plpgsql security definer set search_path = public as $$
declare k public.kilometraje; d double precision; h double precision; hoy date := (new.creado at time zone 'America/Bogota')::date;
begin
  if tg_op = 'UPDATE' and new.creado = old.creado and new.lat = old.lat and new.lon = old.lon then
    return new;   -- not a new position (a rename, a new odometer reading): nothing to add
  end if;
  insert into public.kilometraje (clave) values (new.clave) on conflict (clave) do nothing;
  select * into k from public.kilometraje where clave = new.clave for update;
  if k.dia is distinct from hoy then k.dia := hoy; k.km_hoy := 0; k.odo_dia_km := new.odometro_km; end if;
  if new.odometro_km is not null and new.odometro_km > 0 then
    k.odo_km := new.odometro_km;
    k.odo_dia_km := coalesce(k.odo_dia_km, new.odometro_km);
  end if;
  if new.precision_m is null or new.precision_m <= 100 then
    if k.lat is null or k.t is null or new.creado <= k.t then
      if k.lat is null then k.lat := new.lat; k.lon := new.lon; k.t := new.creado; end if;
    else
      d := 2 * 6371.0088 * asin(sqrt(power(sin(radians(new.lat - k.lat) / 2), 2)
             + cos(radians(k.lat)) * cos(radians(new.lat)) * power(sin(radians(new.lon - k.lon) / 2), 2)));   -- km
      h := extract(epoch from new.creado - k.t) / 3600;
      if d * 1000 < greatest(30, coalesce(new.precision_m, 0)) then
        null;                                              -- temblor: no se mueve el ancla
      elsif h > 0 and d / h > 180 and k.saltos < 3 then
        k.saltos := k.saltos + 1;                          -- salto imposible: se ignora (tres seguidos = el ancla estaba mal)
      else
        if k.saltos < 3 then k.km_gps := k.km_gps + d; k.km_hoy := k.km_hoy + d; end if;
        k.lat := new.lat; k.lon := new.lon; k.t := new.creado; k.saltos := 0;
      end if;
    end if;
  end if;
  update public.kilometraje set km_gps = k.km_gps, dia = k.dia, km_hoy = k.km_hoy, odo_km = k.odo_km, odo_dia_km = k.odo_dia_km,
    lat = k.lat, lon = k.lon, t = k.t, saltos = k.saltos, actualizado = now() where clave = new.clave;
  new.km_hoy := round((case when k.odo_km is not null and k.odo_dia_km is not null then k.odo_km - k.odo_dia_km else k.km_hoy end)::numeric, 1);
  new.km_total := round(km_mostrar(k)::numeric, 1);
  return new;
end $$;
drop trigger if exists ubicaciones_km on public.ubicaciones;
create trigger ubicaciones_km before insert or update on public.ubicaciones
  for each row execute function public.ubicaciones_km();
revoke all on function public.ubicaciones_km() from public, anon, authenticated;

-- "Odómetro" en el mapa: el equipo pone la lectura real del vehículo; desde ahí se suma lo que recorra.
create or replace function public.fijar_odometro(clave text, km double precision) returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare k public.kilometraje;
begin
  if auth.uid() is null then raise exception 'Inicie sesión para cambiar el kilometraje'; end if;
  if fijar_odometro.clave not like 'd:%' and fijar_odometro.clave not like 't:%' then
    raise exception 'Solo se puede poner el odómetro de un vehículo'; end if;
  if km is null or km < 0 or km > 5000000 then raise exception 'Kilometraje inválido'; end if;
  insert into public.kilometraje (clave) values (fijar_odometro.clave) on conflict (clave) do nothing;
  update public.kilometraje set base_km = km, base_km_gps = km_gps, base_en = now(), odo_km = null, odo_dia_km = null, actualizado = now()
    where clave = fijar_odometro.clave returning * into k;
  update public.ubicaciones set km_total = round(km_mostrar(k)::numeric, 1) where clave = fijar_odometro.clave;
end $$;
revoke all on function public.fijar_odometro(text, double precision) from public, anon;
grant execute on function public.fijar_odometro(text, double precision) to authenticated;

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
  insert into public.dispositivos (nombre, tipo, clave_hash, clave_qr)
  values (nuevo_dispositivo.nombre, nuevo_dispositivo.tipo, encode(extensions.digest(k, 'sha256'), 'hex'),
    case when nuevo_dispositivo.tipo = 'servidor' then null else k end);
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

-- Panel "🚑 Vehículos" del tablero (con sesión del equipo): lista, crear, código QR, activar/desactivar.
-- El QR lleva la clave del vehículo, así que cualquiera del equipo puede verla: con ella solo se envían posiciones.
create or replace function public.vehiculos() returns table (id bigint, nombre text, activo boolean, con_qr boolean, creado timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Inicie sesión'; end if;
  return query select d.id, coalesce(n.nombre, d.nombre), d.activo, d.clave_qr is not null, d.creado
    from public.dispositivos d left join public.ubicaciones_nombres n on n.clave = 'd:' || d.id
    where d.tipo <> 'servidor' order by d.activo desc, coalesce(n.nombre, d.nombre);
end $$;

create or replace function public.crear_vehiculo(nombre text) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare k text := encode(extensions.gen_random_bytes(18), 'hex'); n text := left(trim(crear_vehiculo.nombre), 40); i bigint;
begin
  if auth.uid() is null then raise exception 'Inicie sesión'; end if;
  if coalesce(n, '') = '' then raise exception 'Escriba el nombre del vehículo, por ejemplo Móvil 20'; end if;
  insert into public.dispositivos (nombre, tipo, clave_hash, clave_qr)
  values (n, 'vehiculo', encode(extensions.digest(k, 'sha256'), 'hex'), k) returning id into i;
  return i;
end $$;

-- La clave para el QR. Los vehículos creados antes de existir el QR no la tienen guardada: con nueva = true se
-- les da una clave nueva (el celular que usaba la anterior deja de enviar hasta escanear el QR nuevo).
create or replace function public.vehiculo_qr(id bigint, nueva boolean default false) returns text
language plpgsql security definer set search_path = public, extensions as $$
#variable_conflict use_column
declare d public.dispositivos; k text;
begin
  if auth.uid() is null then raise exception 'Inicie sesión'; end if;
  select * into d from public.dispositivos where dispositivos.id = vehiculo_qr.id and tipo <> 'servidor';
  if d.id is null then raise exception 'No existe ese vehículo'; end if;
  if d.clave_qr is not null and not nueva then return d.clave_qr; end if;
  if not nueva then return null; end if;
  k := encode(extensions.gen_random_bytes(18), 'hex');
  update public.dispositivos set clave_hash = encode(extensions.digest(k, 'sha256'), 'hex'), clave_qr = k
    where dispositivos.id = d.id;
  return k;
end $$;

create or replace function public.activar_vehiculo(id bigint, activo boolean) returns void
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  if auth.uid() is null then raise exception 'Inicie sesión'; end if;
  update public.dispositivos set activo = activar_vehiculo.activo where dispositivos.id = activar_vehiculo.id and tipo <> 'servidor';
  if not activar_vehiculo.activo then delete from public.ubicaciones where clave = 'd:' || activar_vehiculo.id; end if;
end $$;

revoke all on function public.vehiculos() from public, anon;
revoke all on function public.crear_vehiculo(text) from public, anon;
revoke all on function public.vehiculo_qr(bigint, boolean) from public, anon;
revoke all on function public.activar_vehiculo(bigint, boolean) from public, anon;
grant execute on function public.vehiculos() to authenticated;
grant execute on function public.crear_vehiculo(text) to authenticated;
grant execute on function public.vehiculo_qr(bigint, boolean) to authenticated;
grant execute on function public.activar_vehiculo(bigint, boolean) to authenticated;

-- La función "ubicacion" entra con la clave secreta (rol service_role). Los proyectos nuevos de Supabase no le dan
-- permisos de tabla solos, así que se dan aquí, solo los que la función usa.
grant usage on schema public to service_role;
grant select on public.dispositivos to service_role;
grant select, insert, update on public.ubicaciones to service_role;
grant insert on public.ubicaciones_recorrido to service_role;
grant select on public.ubicaciones_nombres to service_role;

-- Avisos en vivo al mapa.
do $$ begin
  alter publication supabase_realtime add table public.ubicaciones;
exception when duplicate_object then null; end $$;
