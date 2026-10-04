# Migración de persistencia de Itako a MongoDB Atlas

## Qué se conservó

La pantalla `web/src/pages/itako/app.tsx` sigue usando la misma capa compatible con `.from()`, `.select()`, `.eq()`, `.insert()`, `.update()`, `.delete()` y `.rpc()`. No se reemplazó la interfaz por otra aplicación.

## Nueva persistencia

El servicio productivo es `mongo-backend/`.

- `MONGODB_URI` conecta al cluster.
- `MONGODB_DATABASE` debe ser `itako`.
- El backend crea índices al iniciar.
- El backend hace `Ping` antes de aceptar tráfico.
- Los datos financieros no se siembran.

## Colecciones

| Colección | Uso |
|---|---|
| `users` | Usuario único de autenticación |
| `profiles` | Perfil del administrador |
| `organizations` | Organización única |
| `organization_members` | Relación del usuario con la organización |
| `locations` | Local único |
| `categories` | Categorías del menú |
| `items` | Productos y artículos de paquete |
| `itako_packages` | Paquetes |
| `itako_package_components` | Componentes de paquetes |
| `orders` | Encabezados de pedidos |
| `order_items` | Líneas de pedido |
| `order_payments` | Pagos |
| `itako_expenses` | Gastos |
| `itako_employees` | Empleados |
| `itako_employee_work_days` | Días trabajados y pago |
| `inventory_items` | Inventario |
| `inventory_movements` | Historial de movimientos |
| `itako_staff_consumptions` | Consumo interno |
| `itako_cash_days` | Fondo y cierre diario |
| `itako_delivery_payouts` | Dinero separado para repartidor |

No se crean colecciones para roles, sucursales múltiples ni cuentas adicionales porque esta entrega es para una sola taquería y un solo usuario.

## Reglas de negocio server-side

- Pastor: `floor(cantidad / 2)` gratis.
- Gringas normales: pares a $50 y sobrante al precio individual.
- Gringa de asada: pares a $60 y sobrante al precio individual.
- Delivery: $10 al cliente, separado como pago al repartidor y excluido de ventas.
- Efectivo: el servidor valida que lo recibido cubra el total y registra cambio.
- Transferencia: no genera efectivo en caja ni cambio.
- Propina: se guarda separada y no incrementa la venta.
- Pedidos pendientes pueden editarse; pedidos cobrados no.

## Backend histórico

El directorio `backend/` original sigue presente para conservar el código histórico y no borrar módulos existentes. Render no lo compila ni lo ejecuta. El `Dockerfile` raíz compila exclusivamente `mongo-backend/` y la aplicación React.
