-- SAT Tolima: incidentes compartidos (Supabase).
-- Pegue todo este archivo en Supabase > SQL Editor > New query y pulse "Run". Se puede correr más de una vez.

create table if not exists public.incidentes (
  id          text primary key,
  datos       jsonb not null default '{}'::jsonb,   -- título, tipo, municipio, lugar, descripción, punto, límite…
  estado      text,
  afectados   jsonb,
  fecha       text,                                  -- fecha y hora del incidente (hora Colombia, "AAAA-MM-DDTHH:MM")
  autor       text,
  creado      timestamptz not null default now(),
  actualizado timestamptz not null default now()
);

create table if not exists public.actualizaciones (
  id           text primary key,
  incidente_id text not null references public.incidentes(id) on delete cascade,
  creado       timestamptz not null default now(),
  autor        text,
  texto        text,
  estado       text,      -- nuevo estado, si la actualización lo cambió
  afectados    jsonb      -- cifras nuevas, si la actualización las cambió
);
create index if not exists actualizaciones_incidente on public.actualizaciones(incidente_id, creado);

create table if not exists public.medios (
  id               text primary key,
  incidente_id     text not null references public.incidentes(id) on delete cascade,
  actualizacion_id text references public.actualizaciones(id) on delete cascade,
  ruta             text not null,   -- ruta del archivo en el bucket "incidentes"
  nombre           text,
  tipo             text,
  creado           timestamptz not null default now()
);
create index if not exists medios_incidente on public.medios(incidente_id);

-- Solo las cuentas del equipo (creadas en Authentication > Users) pueden leer y escribir.
alter table public.incidentes      enable row level security;
alter table public.actualizaciones enable row level security;
alter table public.medios          enable row level security;

drop policy if exists "equipo" on public.incidentes;
drop policy if exists "equipo" on public.actualizaciones;
drop policy if exists "equipo" on public.medios;
create policy "equipo" on public.incidentes      for all to authenticated using (true) with check (true);
create policy "equipo" on public.actualizaciones for all to authenticated using (true) with check (true);
create policy "equipo" on public.medios          for all to authenticated using (true) with check (true);

-- Permiso de tabla para las cuentas del equipo (los proyectos nuevos de Supabase no lo dan solos).
grant usage on schema public to authenticated;
grant select, insert, update, delete on public.incidentes, public.actualizaciones, public.medios to authenticated;

-- Avisos en vivo: el tablero y el formulario se refrescan solos cuando otro dispositivo guarda algo.
do $$ begin
  alter publication supabase_realtime add table public.incidentes, public.actualizaciones, public.medios;
exception when duplicate_object then null; end $$;

-- Fotos y videos: bucket privado (se ven con enlaces firmados que vencen a las 6 horas).
insert into storage.buckets (id, name, public) values ('incidentes', 'incidentes', false)
on conflict (id) do nothing;

drop policy if exists "equipo incidentes" on storage.objects;
create policy "equipo incidentes" on storage.objects for all to authenticated
  using (bucket_id = 'incidentes') with check (bucket_id = 'incidentes');
