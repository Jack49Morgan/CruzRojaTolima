# Incidentes compartidos con Supabase

Con esto, un incidente registrado en el teléfono aparece en el computador (y al revés), y cualquiera
del equipo puede agregarle actualizaciones mientras está en curso. Supabase es gratis para este uso
(500 MB de datos, 1 GB de fotos y videos, máximo 50 MB por archivo) y no pide tarjeta.

## 1. Crear el proyecto (5 minutos)

1. Entre a <https://supabase.com>, pulse **Start your project** y entre con su cuenta de GitHub.
2. **New project**: nombre `sat-tolima`, una contraseña de base de datos (guárdela, no se usa en la página),
   región **East US (North Virginia)** o **São Paulo**, plan **Free**.
3. Espere a que diga que el proyecto está listo.

## 2. Crear las tablas

1. Menú izquierdo **SQL Editor** > **New query**.
2. Pegue todo el contenido de [`schema.sql`](schema.sql) y pulse **Run**. Debe decir *Success*.

## 3. Crear las cuentas del equipo

1. **Authentication** > **Sign In / Providers**: desactive **Allow new users to sign up**
   (así nadie más puede crearse una cuenta).
2. **Authentication** > **Users** > **Add user** > **Create new user**: correo y contraseña de cada persona,
   con **Auto Confirm User** marcado. Empiece por la suya.

## 4. Pasar los datos de conexión

**Project Settings** > **API** (o **Data API**): copie

- **Project URL** (algo como `https://abcdxyz.supabase.co`)
- la clave **Publishable** (`sb_publishable_…`) o, en proyectos antiguos, la **anon public** (`eyJ…`)

y péguelas en `INC_CONFIG` al comienzo de `incstore.js`. Esa clave es pública por diseño: sin una
cuenta del equipo no permite leer ni escribir nada.

La acción **Mantener activo Supabase** lee una fila dos veces por semana para que Supabase no pause
el proyecto por inactividad.
