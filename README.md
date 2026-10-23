# Savings Service (`savings-service`)

[![CI](https://github.com/Luisortiz2406/banklite-savings-service/actions/workflows/ci.yml/badge.svg)](https://github.com/Luisortiz2406/banklite-savings-service/actions/workflows/ci.yml)

Ahorro: bolsillos, metas de ahorro y CDT (certificados de depósito a término).

Parte de **BankLite**, banco digital académico construido con microservicios. Cada
microservicio tiene su propia base de datos y se comunica con los demás por HTTP
(red interna) o por eventos en RabbitMQ.

## Responsabilidad dentro de la arquitectura

Separa dinero de la cuenta del cliente en **bolsillos**, **metas** y **CDT**. El dinero
apartado se mueve en ledger-service a las cuentas de custodia (bolsillos y metas, CDT)
y los intereses salen de la cuenta de Intereses pagados. Usa el patrón *reservar →
registrar en el ledger → aplicar* con reintento por la misma clave.

**Reglas de negocio principales**

- Tasas, plazos, mínimos y topes publicados en `GET /savings/catalog` (p. ej. CDT desde $500.000 con plazos de 30 a 360 días y retención del 4 %).
- Máximo de bolsillos y metas por cliente; meta con valor objetivo mínimo.
- Un CDT no se puede cobrar antes de su vencimiento; «Simular vencimiento» solo existe en demo (`ENABLE_DEMO_MATURITY`).
- No se retira más de lo que tiene el bolsillo; cerrar devuelve todo a la cuenta.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | — |
| Consume eventos | — |
| Llama a | account-service: cuenta propia<br>ledger-service: `/ledger/internal/savings` |
| Lo llaman | rewards-service: retos de ahorro<br>api-gateway (rutas `/savings/*`) |
| Integraciones externas | — |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/savings`), aplica CORS y límite de peticiones, y bloquea las
rutas internas.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- JWT (`@nestjs/jwt`) y `class-validator` para validar todo lo que entra
- Docker (imagen `node:20-alpine`) y despliegue en Railway

## Base de datos (`savings_db`)

| Tabla | Contenido |
|---|---|
| `pockets` | Bolsillos y metas (saldo, intereses ganados, objetivo). |
| `cdts` | CDT (monto, plazo, tasa, vencimiento, estado). |
| `savings_ops` | Operaciones con su `idempotency_key` y transacción del ledger. |

En `database/`:

| Archivo | Qué es |
|---|---|
| `schema.sql` | Esquema (tablas, índices, restricciones), generado con `pg_dump --schema-only` desde la base que crea TypeORM. |
| `seed.sql` | Datos de ejemplo de un escenario de demo compartido por todos los servicios (clientes ficticios Ana y Carlos, con los mismos UUID en todas las bases). |
| `backup.sql` | Respaldo completo (esquema + datos de ejemplo) listo para restaurar. |

Restaurar en una base vacía:

```bash
createdb savings_db
psql "postgres://usuario:clave@localhost:5432/savings_db" -f database/backup.sql
# o, por partes:
psql "$DATABASE_URL" -f database/schema.sql -f database/seed.sql
```

Si se arranca el servicio con una base vacía, TypeORM crea las tablas solo.

## Instalación y ejecución

Requisitos: Node.js 20, PostgreSQL 16.

```bash
npm ci
cp .env.example .env     # completa los secretos (ver abajo)
npm run start:dev        # desarrollo, recarga al guardar
# producción:
npm run build && npm run start:prod
```

Con Docker:

```bash
docker build -t banklite-savings-service .
docker run --env-file .env -p 3013:3013 banklite-savings-service
```

El sistema completo (los 12 servicios, Postgres, RabbitMQ y el gateway) se levanta
desde el repositorio principal con `docker compose up -d --build`.

Comprobar: `curl http://localhost:3013/health`

## Endpoints principales

A través del gateway las rutas son las mismas (`http://localhost:8080/savings/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio y de su base (`SELECT 1`); responde 503 con `status: down` si la base no contesta. |
| GET | `/savings/catalog` | Tasas, plazos y topes de ahorro. |

### Del cliente (`Authorization: Bearer <token de acceso>`)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/savings` | Bolsillos, metas y CDT del cliente. |
| POST | `/savings/pockets` | Crea un bolsillo o una meta. |
| POST | `/savings/pockets/:id/deposit` | Mueve dinero de la cuenta al bolsillo. |
| POST | `/savings/pockets/:id/withdraw` | Devuelve dinero del bolsillo a la cuenta. |
| POST | `/savings/pockets/:id/close` | Saca todo y cierra el bolsillo o la meta. |
| POST | `/savings/cdts` | Abre un CDT. |
| POST | `/savings/cdts/:id/collect` | Cobra un CDT vencido (capital + intereses − retención). |
| POST | `/savings/cdts/:id/demo-mature` | Simula el vencimiento (solo demo). |

## Variables de entorno

Ver `.env.example`. Los secretos se generan con
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (uno distinto
por variable). El servicio **no arranca** si un secreto falta, es corto, es un valor de
ejemplo o se repite entre dos variables (`src/config/env.validation.ts`). En Railway
todas se configuran como variables del servicio, nunca en el código.

| Variable | Obligatoria | Ejemplo / por defecto | Para qué sirve |
|---|---|---|---|
| `NODE_ENV` | No | `development` | `development` en local; `production` en Railway (lo fija el Dockerfile). |
| `PORT` | No | `3013` | Puerto HTTP del servicio. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://savings_svc:<DB_PASSWORD_SAVINGS>@localhost:5432/savings_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de clientes (el mismo valor que en auth-service). |
| `INTERNAL_API_KEY` | **Sí** (no arranca sin ella) | — | Clave interna **propia** de este servicio; la manda en `x-internal-key` al llamar a otros. |
| `LEDGER_SERVICE_URL` | Sí | `http://localhost:3006` | URL interna de ledger-service. |
| `ACCOUNT_SERVICE_URL` | Sí | `http://localhost:3002` | URL interna de account-service. |
| `ENABLE_DEMO_MATURITY` | No | `false` | Muestra «Simular vencimiento» de CDT (solo demo). |
| `HTTP_READ_RETRIES` | No | `1` | Reintentos de las lecturas (GET) a otros servicios; las escrituras no se reintentan. |

## Pruebas

Las reglas de negocio se prueban de punta a punta con los scripts de `scripts/pruebas/` del repositorio principal.

## Despliegue

Desplegado en Railway **desde este repositorio** (rama `main`): `railway.json` en la
raíz define el build por `Dockerfile` y el health check en `/health`; cada push a
`main` redespliega el servicio. El servicio no tiene dominio público propio: se accede
por el gateway.

- Estado del servicio y de su base: [https://api-gateway-production-dd7f.up.railway.app/health](https://api-gateway-production-dd7f.up.railway.app/health) (entrada `savings-service`: `status` y `database` deben estar en `ok`)
- Endpoint público de prueba: https://api-gateway-production-dd7f.up.railway.app/savings/catalog
- Rutas de este servicio: `https://api-gateway-production-dd7f.up.railway.app/savings/...`
- Aplicación web: https://frontend-production-eff3c.up.railway.app

## Repositorios relacionados

Servicios de BankLite con los que se comunica este. **Llama a** / **Lo llama**: HTTP
por la red interna; **Recibe** / **Envía**: eventos en RabbitMQ. Cada uno vive y se
despliega desde su propio repositorio.

| Repositorio | Relación con este servicio |
|---|---|
| [banklite-api-gateway](https://github.com/Luisortiz2406/banklite-api-gateway) | **Lo llama:** punto de entrada público, le enruta las rutas de este servicio |
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Llama a:** cuenta del cliente |
| [banklite-ledger-service](https://github.com/Luisortiz2406/banklite-ledger-service) | **Llama a:** movimientos de dinero (`/ledger/internal/savings`) |
| [banklite-rewards-service](https://github.com/Luisortiz2406/banklite-rewards-service) | **Lo llama:** progreso de los retos de ahorro |
