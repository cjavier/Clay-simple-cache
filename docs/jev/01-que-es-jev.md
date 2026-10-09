# 1. Qué es Jev y para qué sirve

> Fuente principal: documentación oficial en <https://docs.typesafe.ai> (leída completa el 2026-09-29, modelo `jev-1.13.0`, revisión de "jaggedness" del 2026-09-17).

## En una frase

**Jev es un modelo de IA que no escribe texto: toma un `state` (texto o JSON) y una lista de preguntas tipadas, y devuelve decisiones con probabilidades calibradas.** TypeSafe lo define como *"a frontier-intelligence function call: unstructured state in, typed probabilistic decisions out"*. Flavio Copes lo resume como "un `if` inteligente".

```
state + questions ──(1 request)──► Jev evalúa cada pregunta en paralelo ──► answers tipadas + probabilidades + confidence ──► tu código decide (if / sort / route)
```

## Quién lo hace

- **TypeSafe AI** salió de stealth el **15-sep-2026** con **$40M de seed** y Jev como primer modelo público.
- Fundador citado por la prensa: Diego Almeida (co-creador de ChatGPT/RLHF, ex-OpenAI).
- Al lanzamiento el acceso era por waitlist. Para el 20-sep ya estaba abierto a todos.

## La idea de "System One"

El nombre viene de *Thinking, Fast and Slow* de Kahneman. El **Sistema 1** es rápido e intuitivo y el **Sistema 2** es lento y deliberado. Jev es el primer "System One model". Su trabajo son juicios rápidos y acotados, del tipo que un experto haría en unos segundos con el contexto correcto. No razona en varios pasos ni genera contenido.

| | LLM (ChatGPT, Claude, etc.) | Jev (System One) |
|---|---|---|
| Salida | Texto token por token | Valores tipados + distribución de probabilidad |
| Esquema | Hay que pedir "devuelve JSON" y parsear | Tipado por construcción: la respuesta **solo** puede ser una de tus opciones |
| "Alucinación" | Puede inventar valores | No puede salir del esquema (0% type errors). **Sí puede equivocarse semánticamente** |
| Incertidumbre | Tiende a sobreconfianza | Probabilidades calibradas (entrenado con **RLCD**) |
| Varias preguntas | Secuenciales o en un mismo prompt (se contaminan entre sí) | En paralelo e **independientes**: una no es contexto de otra |
| Latencia | 3 – 329 s en las evals de TypeSafe | 70 – 500 ms (típico ~100 ms) |
| Precio | $0.20 – $10 / MTok de input, output ~5x más caro | **$0.042 / MTok de input, output gratis** |

### RLCD

Es la tercera vía de post-entrenamiento que propone TypeSafe:

- **RLHF**: optimiza para que a una persona le guste el texto (chat).
- **RLVR**: optimiza con recompensas verificables (razonamiento).
- **RLCD** (*Reinforcement Learning for Calibrated Decisions*): optimiza para que las probabilidades reflejen la frecuencia real de acierto.

La calibración se mide **sobre grupos de predicciones**. Que una respuesta tenga 0.9 no garantiza que esa respuesta en particular sea correcta. Lo que dice es que, de todas las respuestas con 0.9, aproximadamente el 90% lo son.

## Las tres primitivas

| Primitiva | Pregunta | Devuelve | Límite |
|---|---|---|---|
| **Choice** | ¿Cuál de estas opciones? (sin orden) | `choice`, `probabilities`, `confidence` | hasta **255** opciones |
| **Score** | ¿En qué nivel de esta rúbrica? (ordenado) | `score` (puede caer entre niveles, p. ej. 1.4), `legend`, `probabilities`, `confidence` | **2 – 10** niveles |
| **Noul** | ¿Esto es verdad? (sí/no) | `noul` ∈ [0,1] = probabilidad de "sí" (no trae `confidence`) | — |

Puedes mezclar las tres en una sola llamada. Agregar preguntas casi no mueve la latencia y solo cuesta los tokens de la pregunta.

## Para qué sirve (y para qué no)

### Test de idoneidad

Tomado del gist comunitario de pjburnhill, que coincide con la documentación. Jev encaja bien si contestas **sí** a todo esto:

1. ¿La IA está **decidiendo** y no creando?
2. ¿Puedes definir de antemano el espacio de respuestas?
3. ¿Es **un** juicio enfocado?
4. ¿La información necesaria cabe en el `state`?
5. ¿Un experto lo juzgaría **en segundos**?
6. ¿El resultado lo consume **software** directamente?

### Encaja bien

- Clasificación, ruteo, triage (tickets, emails, leads, intents).
- Detección (PII, spam, phishing, jailbreak, urgencia, "pide reembolso").
- Scoring sobre rúbricas (severidad, frustración, fit de ICP, calidad de un resume).
- Guardrails de entrada y salida para LLMs, y gating de tool-calls riesgosos en agentes.
- Re-ranking y filtrado de relevancia en RAG.
- Extracción **cuando el espacio es acotado**: regex o un LLM proponen candidatos y Jev elige cuál.
- Map-reduce sobre datasets grandes. Es tan barato que puedes hacer una pregunta por fila o por par.
- Tiempo real (UI, personalización, bots de juegos). La latencia de ~100 ms lo permite.

### No encaja

- Generar texto, código, resúmenes o explicaciones.
- Chat.
- Razonamiento de varios pasos (System 2), aritmética, conteo y comparar fechas.
- Reemplazar el LLM de un agente de código. **No existe `model: "jev-latest"` para Claude Code o Cursor.** Lo que sí puedes hacer es usar tu agente para escribir código que llame a Jev.

## Filosofía de arquitectura: "AI-powered software", no agentes

> "Code calculates. Jev judges. Reasoning models reason and generate."

TypeSafe distingue tres arquitecturas:

1. **Software tradicional**: un árbol de decisiones hecho de primitivas deterministas.
2. **Agentes LLM**: el modelo elige su siguiente paso en un loop. Cada vuelta del loop es otra oportunidad de descarrilarse.
3. **AI-powered software**, que es la que proponen: **el código controla el flujo**, y el modelo solo aparece donde hace falta "sentido común programable" o interpretar datos no estructurados.

El flujo típico queda así:

```
código determinista ──► Jev (juicio semántico acotado) ──► código determinista (actuar / revisar / escalar)
```

## Especificaciones de `jev-1.13.0`

| Concepto | Valor |
|---|---|
| Precio | **$0.042 / MTok input** ($42 / BTok). Output gratis |
| Rate limits | 250,000 tokens/s y 1,200 requests/min. Son dinámicos: TypeSafe avisa que pueden cambiar sin previo aviso |
| Contexto | **64k tokens por request** (state + todas las preguntas). **32k** para state + la pregunta más larga |
| Input | Solo texto: string, objeto JSON o array. Sin imágenes, audio ni video |
| Idioma | Principalmente **inglés**. Acepta otros idiomas (incluido español y CJK) con **menor precisión**. Hay que probar con datos propios y vigilar `confidence` |
| Fine-tuning | **No existe**: los mismos pesos sirven a todas las cuentas. Se personaliza vía `state`, `instructions` y `criteria` |
| Datos | No entrenan con tus requests. ZDR disponible para enterprise |
| Aliases | `jev-latest` (estable, default de los SDKs) y `jev-preview` (hoy ambos apuntan a `jev-1.13.0`). Si calibraste umbrales, **fija la versión** (`jev-1.13.0`) |

> **Nota sobre precios:** el sitio comunitario `jevtypesafeai.com` cita "$0.25–$0.42/M". La documentación oficial y todos los demás blogs dicen **$0.042/MTok**. Usa el dato oficial.

## Resultados que reporta TypeSafe (con matices)

- En sus evaluaciones de workflows: "**193.6× más rápido, 444.6× más barato**". Los propios desarrolladores lo presentan como el techo, no como lo típico.
- 67.8% de accuracy en su eval, empatando con Claude Sonnet 5 a 1/293 del costo y 1/195 de la latencia. El resumen de DEV Community aclara que son números propios, sin reproducción independiente, medidos contra etiquetas de consenso de dos LLMs y no contra ground truth.
- TypeSafe reconoce sesgos en sus evals: corrieron desde laptops en la costa oeste, los workflows los creó su propio equipo y los modelos de referencia se envolvieron en un wrapper con restricciones.
- Demos: un bot de Doom (~10 queries/s, ~$7/hora) y Wikiracing (elegir entre cientos o miles de links).

## Lo que la comunidad agrega a la versión oficial

Detalle y enlaces en [05](./05-casos-de-uso-comunidad.md).

- **"No puede alucinar" solo garantiza el formato.** Puede estar *confidently wrong*: con opciones ALLOW y BLOCK, las dos cumplen el esquema. El propio CEO lo admitió en HN.
- **La calibración depende de tu distribución de datos.** Varios autores recomiendan recalibrar con tus etiquetas (Platt o isotónica) y medir con Brier o ECE.
- **`confidence` es una transformación de la probabilidad máxima** (`(N·pmax−1)/(N−1)`), no una señal independiente.
- **No es 100% determinista.** Hay deriva de hasta 0.17 y ~1% de decisiones que se invierten al reintentar. Reordenar las opciones cambia las probabilidades.
- **Cada request lleva ~257 tokens fijos** y no hay prompt caching, así que las preguntas se cobran cada vez. En textos cortos el overhead pesa.
- **En benchmarks independientes el ahorro real es menor al anunciado** (6–12x más rápido, no 200x). Aun así, gana claramente como compuerta de alta confianza, en clasificación masiva, en entity resolution y en guardrails.
- **Pierde** frente a clasificadores fine-tuneados en taxonomías propias, con datos tabulares, en planificación y en ruteo sin contexto de sesión.
- **Competencia:** hay clones abiertos (Kev, Jeff, Laya…) que, según usuarios, quedan por debajo en tareas reales. El 29-sep OpenAI anunció una "Decision API" sobre Luna.

## Enlaces clave

- Docs: <https://docs.typesafe.ai> · índice para agentes: <https://docs.typesafe.ai/llms.txt>
- Consola, API keys y Playground: <https://console.typesafe.ai>
- Blog de lanzamiento: <https://typesafe.ai/blog/introducing-system-one-models-and-jev>
- Evals: <https://evals.typesafe.ai>
- Discord oficial (para reportar failure modes): <https://discord.com/invite/WUujKYBp8s>
