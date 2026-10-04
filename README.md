# Itako — POS para taquería

Itako es un POS en español para una sola taquería. Esta versión conserva la interfaz React/TypeScript/Vite existente y utiliza un backend Go propio con MongoDB Atlas como única persistencia funcional.

## Arquitectura

```text
Navegador
   ↓ HTTPS
Render Web Service
   ├── React + Vite (UI)
   └── Go (API + autenticación + lógica de pedidos)
            ↓
       MongoDB Atlas
            ↓
          base: itako
```

El navegador nunca se conecta directamente a MongoDB.

## Funciones conservadas/adaptadas

- Login de un solo usuario.
- Nueva orden.
- Pedidos del día.
- Edición y cancelación de pedidos pendientes.
- Cobro en efectivo o transferencia.
- Cambio automático.
- Delivery de $10 separado de la venta.
- Promoción de pastor 3x2.
- Promociones de gringas: 2 por $50, excepto asada 2 por $60.
- Paquetes Pastor, Asada y Mixto.
- Caja y fondo para el siguiente día.
- Gastos.
- Empleados y días trabajados.
- Consumo interno del personal.
- Inventario, compras, salidas y merma.
- Ganancias por día/mes.
- Exportación existente.

## Catálogo inicial

El seed inicial solo crea datos maestros permitidos: usuario administrador, organización/local, categorías, productos, paquetes y promociones. No crea ventas, gastos, pagos, empleados ni inventario vendido ficticios.

## Desarrollo local

Requisitos:

- Go 1.25+
- Node.js 22+
- MongoDB Atlas o una instancia MongoDB accesible

Copia `.env.example` a `.env` y completa los secretos. No subas `.env` a GitHub.

Backend:

```bash
cd mongo-backend
go run .
```

Frontend separado, si quieres trabajar con Vite:

```bash
cd web
npm install
npm run dev
```

En ese caso puedes definir `VITE_API_URL=http://localhost:8080` en el entorno del frontend.

## Producción

La opción recomendada es usar el `Dockerfile` de la raíz. Render compila el frontend y el backend dentro del mismo Web Service y Go sirve la aplicación resultante.

Consulta [DEPLOY.md](DEPLOY.md) para los pasos exactos.

## Seguridad

- JWT HS256 con expiración.
- Contraseña del administrador almacenada como hash bcrypt.
- JWT_SECRET solo en variables de entorno.
- MONGODB_URI solo en variables de entorno del servidor.
- CORS restringible.
- Headers básicos de seguridad.
- Límite básico de intentos de login.
- MongoDB accesible solamente desde el backend.
- Manejo de SIGINT/SIGTERM y cierre de MongoDB.

## Importante

El directorio `backend/` que acompaña al proyecto original contiene el backend histórico basado en PostgreSQL. No forma parte del servicio funcional de esta entrega: Render construye exclusivamente `mongo-backend/` mediante el `Dockerfile` de la raíz. Se conserva para no borrar código histórico del proyecto original.
