# Jev (TypeSafe AI): documentación de referencia

> Investigación del 2026-09-29, dos semanas después del lanzamiento. Se basa en la documentación oficial completa (`docs.typesafe.ai`, 111 páginas), los 18 cookbooks, unas 480 historias de Hacker News, hilos de Reddit, unos 70 repos de GitHub y unas 45 fuentes entre blogs y posts de dev.to.

## TL;DR

**Jev** es un "System One model": un modelo de IA que **no genera texto**. Recibe un `state` (texto o JSON) y un mapa de preguntas tipadas, y en ~100 ms devuelve **decisiones con probabilidades calibradas**:

- **Choice** elige 1 de hasta 255 opciones.
- **Score** ubica el state en una rúbrica de 2 a 10 niveles.
- **Noul** da la probabilidad de que algo sea verdad.

La respuesta nunca sale de tu esquema. Cuesta **$0.042 por millón de tokens de input** y el output es gratis.

```bash
curl -X POST https://api.typesafe.ai/v1/systemone -H "Authorization: Bearer $TYPESAFE_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"jev-latest","state":"Help! My payouts have been failing for 3 days.",
       "questions":{"is_urgent":{"type":"noul","instructions":"Does this convey urgency?"}}}'
# → {"answers":{"is_urgent":{"type":"noul","noul":0.95}}, "model":"jev-1.13.0", ...}
```

**Filosofía:** *"Code calculates. Jev judges. LLMs reason and generate."* El código controla el flujo y Jev se usa solo para juicios de segundos, atómicos y con un espacio de respuestas conocido. El código hace umbral sobre la confianza para actuar, pedir revisión o escalar.

**Sirve para:** clasificar, rutear, detectar, puntuar, rerankear, verificar y poner guardrails a alto volumen o en tiempo real.

**No sirve para:** generar texto, chat, razonamiento de varios pasos, aritmética, fechas ni conteo.

## Índice

| # | Archivo | Contenido |
|---|---|---|
| 1 | [01-que-es-jev.md](./01-que-es-jev.md) | Qué es, System One y RLCD, comparación con LLMs, specs, precios, límites, modelos, cuándo sí y cuándo no, matices de la comunidad |
| 2 | [02-api-y-sdks.md](./02-api-y-sdks.md) | Endpoint HTTP, request y response, errores, SDK TypeScript y Python, gateways (OpenRouter, Vercel, Pydantic, Cloudflare), Pydantic AI, skill para Claude Code |
| 3 | [03-disenar-preguntas.md](./03-disenar-preguntas.md) | **La guía práctica**: cómo armar el state, elegir la primitiva, escribir preguntas y rúbricas, fijar umbrales de confianza, estructura JSON avanzada, failure modes de `jev-1.13`, gotchas y checklist |
| 4 | [04-patrones-y-cookbooks.md](./04-patrones-y-cookbooks.md) | Patrones oficiales (fan-out, confidence routing, composite scoring, intent routing, cascade) y resumen de los 18 cookbooks con código y resultados. Mapa de casos por industria |
| 5 | [05-casos-de-uso-comunidad.md](./05-casos-de-uso-comunidad.md) | Casos reales con números, repos destacados, benchmarks independientes, elogios y críticas de HN y Reddit, ecosistema (SDKs, MCP, DBs, clones), tips y gotchas, ideas creativas |
| 6 | [06-ideas-para-clay-cache.md](./06-ideas-para-clay-cache.md) | Hipótesis de dónde encaja Jev en **este repo**: LinkedIn Finder, dedupe de perfiles, guardrails de `/copy`, ruteo de `/explore`, ICP, triage de respuestas y DNC |

## Las 10 reglas que más importan

1. **Un juicio por pregunta.** Si piensas "y" u "o", sepáralo en dos y combínalo en código.
2. **Todas las preguntas sobre el mismo state en un solo request**, incluidas las especulativas. Se evalúan en paralelo, no se contaminan entre sí y el state se paga una vez.
3. **Todo lo determinista va en código**: fechas, montos, conteos, regex. Jev lee literal y no sabe hacer cuentas.
4. **Filtra el state.** El ruido baja la precisión, y el tope es de 32k tokens para state + pregunta.
5. **Siempre incluye una opción `none` / `other`.** Sin ella, Jev elige mal con alta confianza.
6. **Score:** describe situaciones concretas por nivel, no "bajo, medio, alto" ni números. **Noul:** redacta la pregunta para que "sí" signifique lo que buscas.
7. **Umbrales según el riesgo, con zona gris** (p. ej. <0.3 no, >0.7 sí, y en medio va a un humano o a un LLM). **Calíbralos con tus datos**: ajusta el umbral, no el prompt.
8. **Choice relativo + Noul absoluto** cuando necesites saber "cuál" y también "si alguna".
9. **Fija la versión** (`jev-1.13.0`) y **loguea** `response.model` y las probabilidades.
10. **Arranca en shadow mode** junto al sistema actual, mide y automatiza primero el camino de alta confianza.

## Fuentes principales

- Documentación oficial: <https://docs.typesafe.ai>. El índice para agentes está en <https://docs.typesafe.ai/llms.txt>.
- Blog de lanzamiento: <https://typesafe.ai/blog/introducing-system-one-models-and-jev>
- Playground: <https://console.typesafe.ai/playground>
- Pydantic AI: <https://pydantic.dev/docs/ai/models/typesafe/>
- Flavio Copes: <https://flaviocopes.com/jev/>
- DEV Community: <https://dev.to/valyuai/how-to-use-jev-a-practical-guide-to-typesafes-system-one-model-g5e>
- Gist comunitario: <https://gist.github.com/pjburnhill/adf8d28efcad9df037bfdece178ef965>
- HN, lanzamiento: <https://news.ycombinator.com/item?id=49717558>
- Listas: <https://github.com/logicrw/awesome-jev-projects> y <https://github.com/Amal-David/awesome-jev>
