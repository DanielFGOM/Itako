# Despliegue de Itako en Render + MongoDB Atlas

## 1. MongoDB Atlas

1. Entra a tu proyecto de MongoDB Atlas.
2. Crea o usa un cluster.
3. Crea un usuario de base de datos con permisos sobre la base `itako`.
4. En **Database > Connect > Drivers**, copia la URI `mongodb+srv://...`.
5. Sustituye `<password>` por la contraseña del usuario de MongoDB.
6. No pegues esa URI en GitHub.
7. En **Network Access**, agrega las IPs de salida que Render muestra para la región de tu servicio. Si tu plan/configuración de Render no te permite restringirlas de forma práctica, puedes usar temporalmente `0.0.0.0/0`, pero es una apertura temporal y debes sustituirla por una lista restringida cuando sea posible.

La aplicación usa exclusivamente la base `itako`.

## 2. GitHub

1. Crea un repositorio nuevo.
2. Sube todo el contenido de esta carpeta.
3. No subas `.env` ni credenciales.
4. Sí debes conservar `.env.example`, `README.md`, `DEPLOY.md`, `render.yaml` y `Dockerfile`.

## 3. Render

La configuración recomendada es **un solo Web Service Docker**. El contenedor compila React/Vite y el backend Go, y luego Go sirve ambos en el mismo dominio.

En Render:

1. **New + > Web Service**.
2. Conecta el repositorio de GitHub.
3. Selecciona **Docker**.
4. Dockerfile: `./Dockerfile`.
5. Docker context: `.`.
6. Health Check Path: `/health`.
7. No necesitas un Build Command ni Start Command adicionales: Dockerfile ya define ambos procesos.

## 4. Variables de entorno de Render

Agrega estas variables:

- `MONGODB_URI` = URI privada de MongoDB Atlas.
- `MONGODB_DATABASE` = `itako`.
- `JWT_SECRET` = una cadena aleatoria larga, de al menos 32 caracteres.
- `ITAKO_ADMIN_EMAIL` = `Itakotaqueria@gmail.com`.
- `ITAKO_ADMIN_PASSWORD` = contraseña inicial segura para entrar a Itako.
- `CORS_ORIGINS` = normalmente no es necesaria si frontend y backend se sirven desde el mismo dominio. Si usas otro frontend, coloca solamente su origen, por ejemplo `https://tu-frontend.onrender.com`.

`ITAKO_ADMIN_PASSWORD` solo se usa para generar/guardar el hash bcrypt del usuario inicial. Nunca se envía al navegador ni se guarda como contraseña en MongoDB. Para una operación posterior puedes reemplazarla por `ITAKO_ADMIN_PASSWORD_HASH` y quitar `ITAKO_ADMIN_PASSWORD`.

## 5. Deploy

1. Guarda las variables.
2. Pulsa **Deploy**.
3. Espera a que el build termine.
4. Abre la URL que Render muestra para el servicio.
5. Debe aparecer directamente el login de Itako.
6. Comprueba `https://TU-URL.onrender.com/health`: debe responder JSON con estado `ok` y base `mongodb`.

## 6. Qué no modificar

No cambies `MONGODB_DATABASE` de `itako`, no pongas secretos en el frontend y no conectes React directamente a MongoDB.
