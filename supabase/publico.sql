-- Vista pública de solo lectura del seguimiento de eventos.
-- Cualquiera con el enlace puede leer los eventos y sus actualizaciones (texto, estado, cifras y horas),
-- pero NO los correos del equipo (columna "autor") ni las fotos y videos (tabla "medios" y el bucket siguen privados).
-- Pegue esto en Supabase > SQL Editor > New query y pulse Run. Para deshacerlo, corra las líneas "revoke" del final.

grant usage on schema public to anon;
grant select (id, datos, estado, afectados, fecha, creado, actualizado) on public.incidentes to anon;
grant select (id, incidente_id, creado, texto, estado, afectados) on public.actualizaciones to anon;

drop policy if exists "publico lee" on public.incidentes;
drop policy if exists "publico lee" on public.actualizaciones;
create policy "publico lee" on public.incidentes      for select to anon using (true);
create policy "publico lee" on public.actualizaciones for select to anon using (true);

-- Para volver a solo equipo:
-- revoke select on public.incidentes, public.actualizaciones from anon;
