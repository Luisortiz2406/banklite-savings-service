# Savings Service (`savings-service`)

[![Despliegue](https://github.com/Luisortiz2406/banklite-savings-service/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/Luisortiz2406/banklite-savings-service/actions/workflows/deploy.yml)

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
- **Cuenta cancelada** (`account.closed`): se cierran los bolsillos y metas activos en $0 (`status = closed`, `closed_at`). Los que tienen dinero o una operación en proceso **no se tocan** y quedan en el log (`warn`, con el id y el saldo); los CDT tampoco. Procesar el evento dos veces no cambia nada.

**Comunicación con otros servicios**

| | |
|---|---|
| Publica eventos | — |
| Consume eventos | `account.closed` (account), cola `savings-service.account-closed` con reintentos y DLQ |
| Llama a | account-service: cuenta propia<br>ledger-service: `/ledger/internal/savings` |
| Lo llaman | rewards-service: retos de ahorro<br>account-service: resumen para cancelar la cuenta (`/internal/savings/...`)<br>api-gateway (rutas `/savings/*`) |
| Integraciones externas | — |

Todo el tráfico externo entra por el **api-gateway** (único servicio público), que
enruta por prefijo (`/savings`), aplica CORS y límite de peticiones, y bloquea las
rutas internas.

## Tecnologías

- Node.js 20, NestJS 10 y TypeScript
- PostgreSQL con TypeORM (`synchronize: true`: las tablas se crean desde las entidades)
- RabbitMQ (amqplib): exchange `banklite.events`, reintentos (`<cola>.retry`) y DLQ (`<cola>.dlq`)
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

El sistema completo (los 12 servicios, Postgres, RabbitMQ, el gateway y el frontend) se
levanta con el `docker-compose.yml` del repositorio de integración de BankLite:
`scripts/clonar-repos.sh` clona este repo junto a los demás y `docker compose up -d --build`
construye cada servicio desde su clon (gateway en http://localhost:8080, app en
http://localhost:5500).

Comprobar: `curl http://localhost:3013/health`

## Endpoints principales

A través del gateway las rutas son las mismas (`http://localhost:8080/savings/...`).

### Públicos (sin sesión)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio y de su base (`SELECT 1`); responde 503 con `status: down` si la base no contesta. Además, `eventos`: `conectado`, `sin_conexion` o `sin_configurar` (si se está escuchando `account.closed`); **no cambia `status`**, porque sin RabbitMQ el resto del servicio funciona. |
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

### Internos (solo red privada, `x-internal-key`; el gateway responde 404 desde afuera)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/internal/savings/users/:idUser/resumen-cierre` | Solo **account-service**: bolsillos y metas con dinero, saldo apartado, CDT vigentes (`opening`, `active`, `collecting`) y operaciones en proceso, con `sinPendientes`. Lo usa «Cancelar mi cuenta». |

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
| `METRICS_PORT` | No | `9100` | Puerto de `GET /metrics` (Prometheus), solo para la red privada; **no** es el puerto público (`PORT`). `off` lo apaga. |
| `DATABASE_URL` | **Sí** (no arranca sin ella) | `postgres://savings_svc:<DB_PASSWORD_SAVINGS>@localhost:5432/savings_db` | Conexión a PostgreSQL de **su** base (rol propio, sin acceso a las demás). |
| `JWT_SECRET` | **Sí** (no arranca sin ella) | — | Firma de los JWT de clientes (el mismo valor que en auth-service). |
| `INTERNAL_API_KEY` | **Sí** (no arranca sin ella) | — | Clave interna **propia** de este servicio; la manda en `x-internal-key` al llamar a otros. |
| `LEDGER_SERVICE_URL` | Sí | `http://localhost:3006` | URL interna de ledger-service. |
| `ACCOUNT_SERVICE_URL` | Sí | `http://localhost:3002` | URL interna de account-service. |
| `INTERNAL_TRUSTED_KEYS` | Para el resumen de cierre | `account:<clave-de-account>` | Quién puede pedir `/internal/savings/...` (solo `account`). Sin ella se rechaza todo. |
| `ENABLE_DEMO_MATURITY` | No | `false` | Muestra «Simular vencimiento» de CDT (solo demo). |
| `HTTP_READ_RETRIES` | No | `1` | Reintentos de las lecturas (GET) a otros servicios; las escrituras no se reintentan. |
| `RABBITMQ_URL` | No | `amqp://banklite:<RABBITMQ_PASSWORD>@localhost:5672` | Conexión a RabbitMQ para escuchar `account.closed`. Sin ella el servicio funciona, pero no cierra los bolsillos y metas vacíos de una cuenta cancelada. Si falta, no tiene contraseña o no conecta, el log lo avisa al arrancar (`⚠ …`; el de «sin conexión» se repite cada 5 min mientras siga así) y `/health` muestra `eventos: sin_configurar` o `sin_conexion`. |
| `RABBITMQ_EXCHANGE` | No | `banklite.events` | Exchange topic de eventos. |
| `EVENT_MAX_RETRIES` | No | `5` | Reintentos de un evento antes de mandarlo a la DLQ. |
| `EVENT_RETRY_DELAY_MS` | No | `10000` | Espera entre reintentos de un evento. |

## Pruebas

```bash
npm test   # con TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres para las de base
```

Con base: el resumen para cancelar la cuenta (bolsillos y metas con dinero, CDT vigentes, operaciones en proceso, otros clientes no cuentan). Permisos del endpoint interno (solo `account`). Cuenta cancelada (`account.closed`): cierra los vacíos, no toca los que tienen dinero (ni un centavo) ni los que tienen una operación en proceso, ni los CDT, ni los de otro cliente; el evento repetido o simultáneo no cambia nada. El CI corre con Postgres.

Para probarlo a mano con el sistema completo levantado:

```bash
curl http://localhost:8080/savings/catalog                        # tasas, plazos y topes (público)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/savings  # bolsillos, metas y CDT
```

Para mover dinero hace falta saldo: en local, la consignación de prueba del ledger
(`ENABLE_DEMO_DEPOSITS`) lo abona desde el dashboard. Cada movimiento debe aparecer en
el ledger como tipo `saving`, y cerrar un bolsillo debe devolver todo a la cuenta.

Bolsillos, metas y CDT (`savings.service.spec.ts`): la plata nunca queda a medias. Si el ledger rechaza, lo reservado se devuelve; si no se sabe (red o 5xx), la operación queda pendiente y se completa con la misma clave sin moverla dos veces. Intereses, retención del 4 % del CDT, cobro al vencimiento y resumen. Asientos del ledger (`savings-clients.service.spec.ts`), mensajes de `account.closed`, controladores, reintentos, guards y validación de configuración.

**Cobertura:** el pipeline la muestra en el resumen de cada corrida y exige un mínimo de 70 % de líneas y 50 % de ramas (`umbral-lineas` y `umbral-ramas` en `deploy.yml`). Hoy está en 94,5 % de líneas y 92,7 % de ramas.

## Despliegue

Lo despliega **GitHub Actions** (`.github/workflows/deploy.yml`, que usa el workflow
reutilizable de [banklite-pipelines](https://github.com/Luisortiz2406/banklite-pipelines)):

1. **test**: lint, formato, build y pruebas con Postgres (también en cada pull request).
2. **docker** (solo `main`): imagen en GHCR `ghcr.io/luisortiz2406/banklite-savings-service`,
   etiquetada con el SHA del commit y `latest` (se guardan las últimas 5).
3. **deploy** (solo `main`): `railway up --ci` sube el commit a Railway, que lo
   construye con el `Dockerfile` y aplica `railway.json` (health check en `/health`);
   el job espera a que el despliegue quede activo.

El repositorio está desconectado del autodeploy de Railway: un push a `main` despliega
solo a través de este pipeline, y únicamente si las pruebas pasan. Rollback: panel de
Railway → *Deployments* → versión anterior → *Rollback*. El servicio no tiene dominio
público propio: se accede por el gateway.

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
| [banklite-account-service](https://github.com/Luisortiz2406/banklite-account-service) | **Llama a:** cuenta del cliente<br>**Lo llama:** resumen para cancelar la cuenta<br>**Recibe:** `account.closed` (cierra los bolsillos y metas vacíos) |
| [banklite-ledger-service](https://github.com/Luisortiz2406/banklite-ledger-service) | **Llama a:** movimientos de dinero (`/ledger/internal/savings`) |
| [banklite-rewards-service](https://github.com/Luisortiz2406/banklite-rewards-service) | **Lo llama:** progreso de los retos de ahorro |
