-- Videos públicos en el seguimiento de eventos.
-- Con esto, cualquiera con el enlace de un evento puede ver sus VIDEOS (no las fotos, que siguen siendo solo del equipo).
-- Requiere haber corrido antes publico.sql. Pegue esto en Supabase > SQL Editor > New query y pulse Run.

-- 1. La lista de medios: solo las filas de video, y sin datos del equipo
grant select (id, incidente_id, actualizacion_id, ruta, nombre, tipo, creado) on public.medios to anon;
drop policy if exists "publico ve videos" on public.medios;
create policy "publico ve videos" on public.medios for select to anon using (tipo like 'video/%');

-- 2. Los archivos: el público puede abrir (con enlace temporal) solo los archivos que son videos de un evento
drop policy if exists "publico ve videos" on storage.objects;
create policy "publico ve videos" on storage.objects for select to anon
  using (bucket_id = 'incidentes' and exists (
    select 1 from public.medios m where m.ruta = storage.objects.name and m.tipo like 'video/%'));

-- Para volver a videos solo del equipo:
-- drop policy "publico ve videos" on storage.objects;
-- drop policy "publico ve videos" on public.medios;
-- revoke select on public.medios from anon;
