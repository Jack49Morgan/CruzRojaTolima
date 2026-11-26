-- SAT Tolima: alertas por SMS (Inalambria Express).
-- Pegue todo este archivo en Supabase > SQL Editor > New query y pulse "Run". Se puede correr más de una vez.

-- Personas inscritas para recibir alertas por SMS (página sms.html), con su autorización de datos (Ley 1581 de 2012).
create table if not exists public.sms_inscritos (
  telefono              text primary key,          -- formato +573001234567
  nombre                text not null,
  municipio             text,
  consentimiento_texto  text not null,             -- texto exacto que la persona aceptó
  consentimiento_fecha  timestamptz not null default now(),
  agente                text,                      -- navegador / celular desde donde se inscribió
  creado                timestamptz not null default now(),
  baja                  timestamptz                -- fecha en que pidió no recibir más SMS (null = activa)
);
alter table public.sms_inscritos enable row level security;
drop policy if exists "equipo lee inscritos sms" on public.sms_inscritos;
create policy "equipo lee inscritos sms" on public.sms_inscritos for select to authenticated using (true);

-- Inscripción y baja desde la página pública: solo tocan el número que la persona escribe.
create or replace function public.sms_alta(nombre text, telefono text, municipio text, consentimiento_texto text, agente text default null)
returns text language plpgsql security definer set search_path = public as $$
begin
  if sms_alta.telefono !~ '^\+573[0-9]{9}$' then raise exception 'Número de celular no válido'; end if;
  if length(trim(coalesce(sms_alta.nombre, ''))) < 2 then raise exception 'Falta el nombre'; end if;
  if length(coalesce(sms_alta.consentimiento_texto, '')) < 50 then raise exception 'Falta la autorización de datos'; end if;
  insert into public.sms_inscritos as s (telefono, nombre, municipio, consentimiento_texto, agente)
  values (sms_alta.telefono, left(trim(sms_alta.nombre), 80), left(sms_alta.municipio, 60), sms_alta.consentimiento_texto, left(sms_alta.agente, 300))
  on conflict (telefono) do update set nombre = excluded.nombre, municipio = excluded.municipio,
    consentimiento_texto = excluded.consentimiento_texto, consentimiento_fecha = now(), agente = excluded.agente, baja = null;
  return 'ok';
end $$;
create or replace function public.sms_baja(telefono text)
returns text language sql security definer set search_path = public as $$
  update public.sms_inscritos set baja = now() where sms_inscritos.telefono = sms_baja.telefono and baja is null;
  select 'ok';
$$;
revoke all on function public.sms_alta(text, text, text, text, text) from public;
revoke all on function public.sms_baja(text) from public;
grant execute on function public.sms_alta(text, text, text, text, text) to anon, authenticated;
grant execute on function public.sms_baja(text) to anon, authenticated;

-- Registro de cada envío por SMS (función "enviar-sms").
create table if not exists public.sms_envios (
  id            bigint generated always as identity primary key,
  creado        timestamptz not null default now(),
  autor         text,
  texto         text,
  destinatarios int,
  prueba        boolean default false,
  trabajos      jsonb,      -- jobId de Inalambria por cada lote
  respuesta     jsonb       -- respuesta de Inalambria (o el error)
);
alter table public.sms_envios enable row level security;
drop policy if exists "equipo lee envios sms" on public.sms_envios;
create policy "equipo lee envios sms" on public.sms_envios for select to authenticated using (true);

-- Los proyectos nuevos de Supabase no dan permisos automáticos sobre las tablas.
grant select, insert, update, delete on public.sms_inscritos, public.sms_envios to service_role;
grant select on public.sms_inscritos, public.sms_envios to authenticated;
grant select, insert, update, delete on public.push_suscripciones, public.alertas_lluvia_estado, public.alertas_enviadas to service_role;
grant usage, select on all sequences in schema public to service_role;
