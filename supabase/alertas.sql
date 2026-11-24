-- SAT Tolima: alertas de lluvia al celular (notificaciones push).
-- Pegue todo este archivo en Supabase > SQL Editor > New query y pulse "Run". Se puede correr más de una vez.

-- Celulares suscritos. Nadie puede leer esta tabla desde la página: solo la tarea programada
-- (con la clave secreta "service_role") la lee para enviar las alertas.
create table if not exists public.push_suscripciones (
  endpoint  text primary key,
  p256dh    text not null,
  auth      text not null,
  agente    text,                        -- navegador / celular, para saber de dónde viene
  creado    timestamptz not null default now(),
  visto     timestamptz not null default now()
);
alter table public.push_suscripciones enable row level security;
-- sin políticas: la clave pública de la página no puede leer, cambiar ni borrar filas directamente

-- Alta y baja pasan por estas dos funciones, que solo tocan la suscripción de ese celular.
create or replace function public.push_alta(endpoint text, p256dh text, auth text, agente text default null)
returns void language sql security definer set search_path = public as $$
  insert into public.push_suscripciones as s (endpoint, p256dh, auth, agente)
  values (push_alta.endpoint, push_alta.p256dh, push_alta.auth, left(push_alta.agente, 300))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
    agente = excluded.agente, visto = now();
$$;
create or replace function public.push_baja(endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from public.push_suscripciones where push_suscripciones.endpoint = push_baja.endpoint;
$$;
revoke all on function public.push_alta(text, text, text, text) from public;
revoke all on function public.push_baja(text) from public;
grant execute on function public.push_alta(text, text, text, text) to anon, authenticated;
grant execute on function public.push_baja(text) to anon, authenticated;

-- Qué umbrales están superados ahora, para avisar una sola vez por cada vez que se superan.
create table if not exists public.alertas_lluvia_estado (
  clave       text primary key,          -- "<código estación>|<ventana en horas>"
  activa      boolean not null default false,
  valor       numeric,
  umbral      numeric,
  actualizado timestamptz not null default now()
);
alter table public.alertas_lluvia_estado enable row level security;
