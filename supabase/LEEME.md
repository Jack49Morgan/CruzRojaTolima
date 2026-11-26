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

# Alertas de lluvia al celular

El botón **🔔 Activar alertas** del tablero suscribe el celular. Cada 15 minutos la acción
**Alertas de lluvia** suma la lluvia de cada estación del IDEAM (24 h y 72 h) y, cuando una supera el
umbral de [`data/umbrales-lluvia.json`](../data/umbrales-lluvia.json), envía una notificación a todos
los celulares suscritos. Avisa una vez; vuelve a avisar solo si la lluvia baja del 90 % del umbral y
lo supera otra vez.

Para activarlo (una sola vez):

1. **Supabase** > **SQL Editor** > **New query**: pegue [`alertas.sql`](alertas.sql) y pulse **Run**.
2. **Supabase** > **Project Settings** > **API Keys**: copie la clave secreta **service_role**
   (o una **Secret key** `sb_secret_…`). Nunca la ponga en la página.
3. **GitHub** > repositorio > **Settings** > **Secrets and variables** > **Actions** > **New repository secret**,
   tres veces: `SUPABASE_SERVICE_ROLE_KEY` (la clave del paso 2), `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY`.
   La llave pública VAPID es la misma que está en `alertas.js`; si cambia el par de llaves, cambie
   también esa línea y todos los celulares deberán activar las alertas de nuevo.

4. **Alertas enviadas a mano** (botón **📣 Enviar alerta** del tablero y de cada evento, solo con sesión iniciada):
   **Supabase** > **Edge Functions** > **Deploy a new function** > **Via Editor**. Nombre: `enviar-alerta`.
   Borre el ejemplo, pegue todo [`functions/enviar-alerta/index.ts`](functions/enviar-alerta/index.ts) y pulse **Deploy**.
   Luego **Edge Functions** > **Secrets**: agregue `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` (los mismos valores del paso 3).

Para cambiar los umbrales, edite `data/umbrales-lluvia.json` en GitHub (por municipio o por estación).
Para probar la entrega: **Actions** > **Alertas de lluvia** > **Run workflow**, marque *prueba*.

# Ubicación en vivo del equipo y de los vehículos

Solo el equipo con sesión iniciada ve en el mapa la capa **Equipo y vehículos en vivo**: una marca por persona y
un carro con su número (Móvil 20, Móvil 42…) por vehículo, con la hora en que se vio por última vez ("hace 40 min").
Las marcas se desvanecen pasados 10 minutos sin posición y quedan grises pasada una hora. Cada posición lleva la hora
en que el GPS la tomó, así que lo que se envía después de estar sin señal queda en su sitio del recorrido.
Solo se guardan las últimas 24 horas.

## Activarlo (una sola vez)

1. **Supabase** > **SQL Editor** > **New query**: pegue [`ubicaciones.sql`](ubicaciones.sql) y pulse **Run**.
2. **Edge Functions** > **Deploy a new function** > **Via Editor**. Nombre: `ubicacion`. Borre el ejemplo, pegue todo
   [`functions/ubicacion/index.ts`](functions/ubicacion/index.ts) y pulse **Deploy**.
3. Abra la función `ubicacion` > **Details** (o **Settings**) y **desactive "Enforce JWT verification"**
   (también llamado *Verify JWT*). Las aplicaciones de GPS no pueden enviar el token de Supabase; la función revisa
   en su lugar la clave de cada dispositivo.

## Personas

El botón **📍 Compartir mi ubicación** se quitó del tablero (2026-11-26). Para seguir a alguien, use OwnTracks con un
QR de vehículo o con una clave de `nuevo_dispositivo(..., 'persona')`.

## Vehículos con código QR (lo más fácil)

Con sesión iniciada, el botón **🚑 Vehículos** del tablero:

- **✏ Editar** (arriba a la derecha, solo administradores): muestra Agregar, el tipo y Eliminar. Para ser administrador, una vez
  en el SQL Editor: `insert into public.admins (user_id) select id from auth.users where email = 'su-correo' on conflict do nothing;`
  La lista inicial de vehículos se crea con `supabase/vehiculos-iniciales.sql` (se puede correr más de una vez).
- **＋ Agregar**: crea el vehículo (por ejemplo `Móvil 20 - Ibagué`) y muestra su **código QR**. Use **🖨 Imprimir** y péguelo en el vehículo.
- El conductor escanea el QR con la cámara del celular (iPhone o Android, con OwnTracks instalado), toca
  **Conectar** y acepta. El celular queda enviando como ese vehículo, en modo Move.
- **Solo la primera vez en cada celular**: en OwnTracks abra Settings (iPhone) o Preferences (Android) > **Remote Control**
  y active **Allow external configuration**. Sin eso OwnTracks responde *"URI or file configuration not allowed"*.
  La página del QR también muestra la URL (**Configurar a mano** > **Copiar URL**) para pegarla en modo HTTP.
- **Cambiar de vehículo**: el conductor escanea el QR del otro vehículo. El celular pasa a enviar como ese.
- **Mi vehículo**: el celular recuerda el último vehículo escaneado. En el tablero aparece **🚑 Mi vehículo: Móvil 20**, que abre
  Pausar / Reanudar / Terminar sin escanear. También se puede **Agregar a inicio** (Safari) o **a la pantalla principal** (Chrome).
- **🗑 Eliminar**: borra el vehículo (pide confirmación); su QR deja de servir. Sus km de días pasados siguen en el informe semanal.
- Vehículos creados antes con `nuevo_dispositivo()` no tienen la clave guardada: el panel ofrece darles una clave
  nueva para hacer su QR (el celular que usaba la clave anterior debe escanear el QR nuevo).

Cualquiera del equipo con sesión puede ver los QR; con la clave solo se pueden enviar posiciones de ese vehículo.

## Vehículos: una clave por cada uno (a mano)

En **SQL Editor** cree el dispositivo; la clave se muestra **una sola vez** (cópiela):

```sql
select * from nuevo_dispositivo('Móvil 20');
```

El número del nombre (20) se ve sobre el ícono del carro. El nombre se puede cambiar después desde el mapa
(**Cambiar nombre** en la ventana del vehículo). Para desactivar uno:
`update dispositivos set activo = false where nombre = 'Móvil 20';`

### Pausa, fin del día e informe semanal de km

- **Tipo**: al agregar un vehículo elija 🚙 Camioneta, 🛻 Pickup, 🚑 Ambulancia o 🚲 Bicicleta (cambia el ícono del mapa; se puede cambiar después).
- **⏸ Pausar / ▶ Reanudar** (página del QR o ventana del vehículo en el mapa): el vehículo queda fijo donde está
  (por ejemplo, en el almuerzo) y no sigue al celular; el día no se cierra.
- **🅿 Terminar recorrido** (página del QR): tóquelo al dejar el vehículo, por ejemplo en el garaje. El vehículo sale
  del mapa y aparece en 🚑 Vehículos como **Recorrido terminado**, con la hora y la dirección, aunque el conductor se vaya con el celular; OwnTracks pasa a modo silencioso y los km del día quedan
  guardados. Al día siguiente, escanee el QR y toque **Conectar**.
- **🗺 Historial de recorridos** (panel 🚑 Vehículos): elija el vehículo y las fechas y toque **Ver en el mapa**; desde ahí se
  exporta en GPX, KML o CSV. Los recorridos de vehículos se guardan **90 días** (cámbielo en `recorrido_dias()` en
  `ubicaciones.sql`); los de personas, 24 h. Unos 170 bytes por punto: 10 vehículos × 8 h diarias ≈ 150 MB en 90 días
  (el plan gratis de Supabase da 500 MB de base de datos).
- **📊 Kilómetros por semana** (panel 🚑 Vehículos): elija la semana o las fechas y toque **⬇ Descargar para Excel**.
  Los km de cada día se guardan sin límite de tiempo (las posiciones, solo 24 h).

### Exportar el recorrido

En la ventana de un vehículo o persona, **Recorrido 24 h · exportar** dibuja el recorrido y muestra arriba del mapa
**GPX** (aplicaciones de GPS), **KML** (Google Earth) y **CSV** (Excel: hora, latitud, longitud, velocidad, km acumulados).
Solo se guardan las últimas 24 horas: exporte antes si necesita conservar un recorrido.

### Kilometraje

La ventana de cada vehículo muestra los **km de hoy** y el **odómetro**. Se suman con cada posición y se guardan
aunque las posiciones se borren a las 24 h. Se ignora el temblor del GPS (menos de 30 m) y los saltos imposibles
(más de 180 km/h). Para que coincida con el vehículo, toque **Odómetro** y escriba la lectura del tablero del carro;
desde ahí se le suma lo recorrido. Si el rastreador envía el odómetro del vehículo (OBD, por Traccar), se usa ese.
Lo que el celular no registra (apagado, sin GPS) no se cuenta: corrija con **Odómetro** cuando haga falta.

La dirección para todos los vehículos es:

    https://hxwntvubhxahzsfhxgav.supabase.co/functions/v1/ubicacion?clave=LA_CLAVE

### OwnTracks en iPhone (celular que va en el vehículo)

1. Abra OwnTracks y acepte la ubicación **Siempre** (Ajustes del iPhone > OwnTracks > Ubicación > **Siempre**,
   con **Ubicación exacta** activada).
2. En OwnTracks toque **ⓘ** (arriba a la izquierda) > **Settings**.
3. **Mode**: `HTTP`.
4. **URL**: la dirección de arriba con la clave de ese vehículo.
5. **Authentication**: apagado (la clave ya va en la dirección). **TrackerID**: el número del móvil, por ejemplo `20`.
6. Vuelva al mapa y toque el botón de seguimiento (arriba a la derecha) hasta que quede en **Move**
   (envía seguido, gasta más batería; para el vehículo, déjelo cargando) o **Significant** (ahorra batería,
   envía cada ~500 m o 5 min).
7. Toque la flecha **⇧** (publicar) para enviar la primera posición ya. En el tablero, con sesión iniciada, aparece el carro.

Sin señal, OwnTracks guarda las posiciones y las envía al recuperarla, cada una con su hora.

### OwnTracks en Android

Preferencias > **Conexión**: Modo **HTTP**, **Host** = la dirección de arriba. Identificación: el número del móvil.
En **Avanzado** desactive la optimización de batería para OwnTracks.

### Traccar Client (Android o iPhone)

**Server URL**: `https://hxwntvubhxahzsfhxgav.supabase.co/functions/v1/ubicacion`
**Device identifier**: la clave del vehículo. **Frequency**: 30 segundos. Active **Offline buffering**.

### Rastreadores GPS de hardware (SinoTrack, Concox, Teltonika…)

Hablan protocolos propios por TCP, así que necesitan un servidor Traccar (gratis, en un servidor propio o
traccar.org) que les reenvíe las posiciones. Cree una clave de tipo servidor:

```sql
select * from nuevo_dispositivo('Servidor Traccar', 'servidor');
```

y en `traccar.xml` del servidor agregue:

```xml
<entry key='forward.enable'>true</entry>
<entry key='forward.json'>true</entry>
<entry key='forward.url'>https://hxwntvubhxahzsfhxgav.supabase.co/functions/v1/ubicacion?clave=LA_CLAVE</entry>
```

Cada rastreador aparece con el nombre que tenga en Traccar (cámbielo desde el mapa si quiere otro).
