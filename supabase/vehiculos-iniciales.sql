-- Lista de vehículos de la Seccional Tolima. Córralo en el SQL Editor de Supabase después de ubicaciones.sql.
-- Se puede correr más de una vez: no duplica vehículos que ya existen (busca por nombre) y no cambia sus claves,
-- así que los celulares ya conectados siguen funcionando.

-- 1. Borra los "Móvil 20" repetidos que nunca enviaron una posición (deja el que usa el celular).
delete from public.dispositivos d
where d.nombre = 'Móvil 20' and d.tipo = 'vehiculo'
  and not exists (select 1 from public.ubicaciones u where u.clave = 'd:' || d.id)
  and not exists (select 1 from public.km_diario k where k.clave = 'd:' || d.id)
  and exists (select 1 from public.dispositivos o where o.nombre = 'Móvil 20' and o.tipo = 'vehiculo' and o.id <> d.id);

-- 2. Crea los que falten y deja a cada uno con su tipo de ícono.
do $$
declare v record; k text; existe bigint;
begin
  for v in select * from (values
      ('Móvil 20',   'camioneta'),
      ('Móvil 42',   'camioneta'),
      ('Móvil 45',   'pickup'),
      ('Ambulancia', 'ambulancia'),
      ('Móvil 6000', 'bicicleta')) as t(nombre, clase)
  loop
    select d.id into existe from public.dispositivos d left join public.ubicaciones_nombres n on n.clave = 'd:' || d.id
      where d.tipo = 'vehiculo' and lower(replace(coalesce(n.nombre, d.nombre), 'Movil', 'Móvil')) = lower(v.nombre)
      order by d.activo desc, d.id limit 1;
    if existe is null then
      k := encode(extensions.gen_random_bytes(18), 'hex');
      insert into public.dispositivos (nombre, tipo, clave_hash, clave_qr, clase)
      values (v.nombre, 'vehiculo', encode(extensions.digest(k, 'sha256'), 'hex'), k, v.clase);
    else
      update public.dispositivos set clase = v.clase, activo = true where id = existe;
      update public.ubicaciones set clase = v.clase where clave = 'd:' || existe;
    end if;
  end loop;
end $$;

select d.id, coalesce(n.nombre, d.nombre) as nombre, d.clase, d.activo
from public.dispositivos d left join public.ubicaciones_nombres n on n.clave = 'd:' || d.id
where d.tipo = 'vehiculo' order by 2;
