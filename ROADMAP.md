# Roadmap — Clay Cache → Plataforma de GTM Engineering

> Visión: pasar de "caché de Clay" a la **plataforma interna de datos y automatización** de la agencia:
> una sola API que resuelve identidad, enriquece, valida, genera copy, respeta listas de exclusión
> y se conecta directamente con las herramientas de envío (Instantly) y CRM de los clientes.

---

## 1. Estado actual (julio 2026)

| Capacidad | Endpoints | Notas |
|---|---|---|
| Caché de perfiles (identidad por email/LinkedIn/teléfono) | `POST/GET /profiles` | Merge de datos, resolución multi-llave |
| Caché de empresas | `POST/GET /companies` | Por dominio o slug de LinkedIn |
| Email finder (permutaciones + SERP + verificación) | `POST /find`, `POST /verify`, `GET /stats` | EmailListVerify + Debounce + Serper, patrones aprendidos por dominio, tracking de costo |
| Detección de tecnología (ecommerce) | `POST /detect-tech` | Shopify, Magento, WooCommerce, etc. |
| LinkedIn finder | `POST /find-linkedin` | Dominio → URL de company en LinkedIn |
| Clientes activos | `POST/GET /clients` | Handle legible (`acme`) como ID de trabajo |
| Listas Do-Not-Contact por cliente | `POST /dnc`, `POST /dnc/check`, `GET /dnc` | Tipos `individual` (email) y `domain` (bloquea todo el dominio) |
| Docs | `GET /docs/api` | HTML navegable |

**En curso (este ciclo):**
- `POST /copy` — generación de copy con DeepSeek (prompt → respuesta).
- `POST /explore` — agente de exploración con herramientas SERP + fetch de sitios; devuelve mensaje final + pasos + reasoning.
- Check DNC integrado como parámetro `dnc_client` en `GET /profiles`, `GET /companies`, `POST /find`, `POST /verify` (si el contacto está vetado, la respuesta es solo `{ do_not_contact: true }` — no se filtran datos).
- Auditoría de bugs + hardening + rediseño de la página de docs.

---

## 2. Fase 0 — Hardening y operación (1–2 semanas)

Lo que hace confiable todo lo demás. Casi todo salió de la auditoría de este ciclo.

- **Migraciones reales**: sustituir `prisma db push` en `start` por `prisma migrate deploy`; carpeta `prisma/migrations/` versionada. `db push` en prod puede destruir datos silenciosamente.
- **Sacar `dist/` del repo** y generar en CI/deploy; borrar archivos muertos (`src/verify_*.ts`, `excalidraw.log`).
- **CI (GitHub Actions)**: `tsc --noEmit` + `vitest run` en cada PR.
- **Rate limiting** por API key (p.ej. `express-rate-limit`) y `express.json({ limit: '1mb' })`.
- **Comparación timing-safe** de la API key y soporte para **múltiples API keys** (una por cliente/herramienta, ver Fase 4).
- **Timeouts y guardias SSRF** consistentes en todos los fetch salientes (tech-detector, explore, linkedin-finder).
- **Logging estructurado** (pino) + request-id; opcional Sentry.
- **OpenAPI spec** generada (`GET /docs/openapi.json`) — habilita Postman collection, SDKs y que agentes de IA consuman el API sin leer HTML.

## 3. Fase 1 — Motor de copy y personalización con IA (2–3 semanas)

Sobre la base de `/copy` y `/explore`:

- **`POST /personalize`** — el endpoint estrella para Clay/Instantly: recibe lead + empresa (o solo email/dominio y él mismo tira del caché/enrichment), scrapea el sitio, y devuelve `first_line`, `ps_line`, `subject` y variables de personalización listas para inyectar en la secuencia. Parámetros: tono, idioma, oferta del cliente, ejemplos few-shot por cliente.
- **Perfiles de voz por cliente**: tabla `client_prompts` (asociada al handle) con system prompts, ofertas, casos de éxito y ejemplos aprobados. `/copy` y `/personalize` reciben `dnc_client`→`client` y cargan su voz automáticamente.
- **`POST /sequence`** — genera la secuencia completa (3–5 correos + follow-ups) en formato compatible con Instantly (steps con `{{variables}}`).
- **`POST /classify-reply`** — clasifica respuestas de prospectos (interesado / not now / unsubscribe / bounce / OOO) con DeepSeek; es la pieza que habilita automatizar el inbox (Fase 2). Las respuestas "unsubscribe" agregan automáticamente a la DNC del cliente.
- **Batch**: versión `POST /personalize/batch` (async, ver jobs en Fase 3).

## 4. Fase 2 — Integración Instantly y ciclo de campaña (2–3 semanas)

Somos una agencia que envía con Instantly: cerrar el loop es el mayor ROI.

- **Sync DNC → Instantly**: job que empuja las listas DNC de cada cliente al blocklist de su workspace de Instantly (API v2). La DNC deja de ser consultiva y pasa a ser aplicada.
- **`POST /instantly/push-leads`**: recibe leads (o un filtro sobre el caché), corre el pipeline completo (enrich → verify → DNC check → personalize) y los sube a una campaña de Instantly. Un solo endpoint reemplaza 6 columnas de Clay.
- **Webhook receiver `POST /webhooks/instantly`**: respuestas → `/classify-reply`; bounces → marcar email inválido en `verification_cache` (el caché aprende de cada campaña); unsubscribes → DNC automática.
- **`GET /campaigns/:client/stats`**: métricas agregadas por cliente (enviados, opens, replies, positivos, costo de enrichment por reunión agendada) — el reporte que hoy se arma a mano.
- Mismo patrón después para **Smartlead** como segundo proveedor (ya hay tooling de Smartlead en la agencia).

## 5. Fase 3 — Enrichment waterfall y jobs asíncronos (3–4 semanas)

- **`POST /enrich`** — endpoint único de waterfall: entra `email` o `dominio+nombre`, y orquesta caché → email finder → LinkedIn finder → tech detect → scrape del sitio → guarda todo en profiles/companies. Un solo crédito lógico, respuesta unificada. Parámetro `dnc_client` integrado.
- **Sistema de jobs**: tabla `jobs` (id, type, status, payload, result, client_handle) + worker. Habilita: CSV upload (`POST /jobs/csv`), batches de personalización, syncs de Instantly, re-verificación periódica de emails viejos (los `expires_at` ya existen).
- **Webhooks salientes**: `POST /webhooks` para registrar URLs por cliente; notificar al completar jobs (compatible con Clay HTTP-API y n8n/Zapier).
- **Señales de compra** (usa `/explore` como motor): `POST /signals` — job postings, funding, lanzamientos, tech migrations del dominio objetivo. Output: lista de triggers con evidencia y fecha, para campañas trigger-based.

## 6. Fase 4 — Multi-tenant, medición y facturación (2 semanas)

- **API keys por cliente** (tabla `api_keys` ligada a `clients`): scoping automático — la key de `acme` solo ve/toca datos y DNC de `acme`; nuestra key maestra ve todo.
- **Metering**: `search_log` ya registra costo; generalizar a `usage_log` por endpoint + cliente. `GET /usage/:client` → reporte mensual (llamadas, costo de providers, costo LLM) — base para facturar enrichment a clientes o controlar márgenes.
- **Cuotas** por cliente (límites mensuales por endpoint).

## 7. Fase 5 — Superficie para agentes (1–2 semanas)

- **Servidor MCP** que expone este API como herramientas (`find_email`, `check_dnc`, `personalize`, `explore`, `enrich`) — cualquier Claude/agente de la agencia opera campañas directamente sobre la plataforma.
- **Docs "agent-first"**: además del OpenAPI, un `GET /docs/llms.txt` con la descripción compacta de cada endpoint (ya en curso en el rediseño de docs).

## 8. Ideas adicionales de servicios (backlog)

- **Salud de deliverability**: `POST /check-domain-health` — SPF/DKIM/DMARC/MX/blacklists del dominio de envío del cliente; monitoreo semanal con alertas.
- **Validación de teléfonos** (`libphonenumber` ya está instalado) + DNC por teléfono (el schema ya lo contempla conceptualmente para `individual`).
- **Detección de ICP-fit / lead scoring**: score 0–100 contra la definición de ICP del cliente (tabla `client_icp`), usando datos del caché + explore.
- **Company lookalikes**: dado un cliente ganado, `/explore` + SERP para encontrar empresas similares (industria, tech stack, tamaño).
- **Sync HubSpot**: empujar reuniones/positivos al CRM del cliente (la agencia ya opera HubSpot).
- **Dashboard interno** (web) sobre `/stats`, `/usage`, campañas y salud de dominios.

## 9. Secuencia recomendada

1. **Fase 0** (hardening) — inmediato; desbloquea producción confiable.
2. **Fase 1** (`/personalize` + voz por cliente) — es lo que más margen genera por campaña.
3. **Fase 2** (Instantly loop) — convierte la DNC y el caché en sistemas que se auto-alimentan.
4. **Fase 3 → 4 → 5** según demanda de clientes.

Cada fase termina con: migración Prisma versionada, tests, docs actualizadas en `/docs/api` y entrada en el changelog del README.
