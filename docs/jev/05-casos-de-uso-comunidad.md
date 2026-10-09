# 5. Casos de uso de la comunidad: foros, GitHub y blogs

*Investigación hecha el 2026-09-29, dos semanas después del lanzamiento (2026-09-15). Solo cubre fuentes de la comunidad: Hacker News, Reddit, dev.to, X, GitHub y blogs de terceros. Deja fuera la documentación oficial, salvo cuando la comunidad la cita.*

## Cómo leer este documento

- **Las cifras son de sus autores.** Salvo que se diga otra cosa, cada número lo reporta el autor del post, repo o comentario. **Ninguna cifra la reproduje yo.** Casi todas vienen de muestras pequeñas o de sets de evaluación propios.
- **Etiquetas:**
  - **[no verificado]**: no pude abrir la fuente primaria, o el dato me llegó de segunda mano.
  - **[especulación]**: el propio autor lo presenta como hipótesis.
  - **[STAFF]**: comentario de personal de TypeSafe. En HN, `CompleteSkeptic` se presenta como CEO ([item](https://news.ycombinator.com/item?id=49718407)) y `zenlikethat` firma como nathan@typesafe.ai ([item](https://news.ycombinator.com/item?id=49720316)).
- **Qué no pude revisar:**
  - Reddit: su API JSON devolvió 403, así que leí los feeds RSS y los comentarios de unos 14 hilos.
  - Lobsters: está detrás de un muro anti-bots, sin resultados.
  - X: solo vi el texto de los tweets, sin las respuestas.
  - YouTube: no lo revisé.
  - Blogs que no cargaron: Tessl, elvex, prospex.ch, el explicativo de DataCamp y un Medium de udit goenka.
- **Tamaño del fenómeno:**
  - En HN hay unas 480 historias que mencionan Jev en dos semanas. El post de lanzamiento tiene 1.989 puntos y 520 comentarios ([HN](https://news.ycombinator.com/item?id=49717558)).
  - El radar curado de logicrw lista 799 proyectos ([GitHub](https://github.com/logicrw/awesome-jev-projects)).
  - Una encuesta en dev.to cuenta 2.170 repos verificados ([dev.to](https://dev.to/linggm3/jev-in-the-wild-the-first-data-driven-survey-of-2170-jev-projects-4i40)).
  - Vercel dice que a las 24 h casi el 13% de sus equipos de pago usaba Jev en AI Gateway ([Vercel](https://vercel.com/blog/ai-gateway-jev-model-launch)).
  - En HN, en Reddit y en X hay acusaciones de astroturfing (ver §2.2), así que el volumen no equivale a adopción real.

### Resumen

1. **Dónde funciona según la comunidad:**
   - Compuertas y "gates" con umbral de confianza: actúa solo si está muy seguro y escala el resto.
   - Clasificación masiva de texto zero-shot.
   - Ruteo con estado rico ya construido.
   - Guardrails de tool calls de agentes.
   - Reranking o selección de contexto.
   - Entity resolution.
   - Bucles en tiempo real (juegos, navegador, computer use) donde el harness hace el trabajo pesado.
2. **Dónde falla o no compensa:**
   - Tareas que requieren razonamiento multi-paso o planificación.
   - Ruteo sin estado de sesión.
   - Severidad de seguridad (CVSS).
   - Datos tabulares y numéricos, aritmética y fechas.
   - Dominios especializados con taxonomías propias, donde un modelo pequeño fine-tuneado le gana.
   - Procesamiento batch offline, donde un LLM con varios registros por prompt y prompt caching puede salir más barato.
3. **Críticas principales:**
   - "Can't hallucinate" es marketing: solo garantiza el formato.
   - La calibración depende de tus datos.
   - `confidence` es una transformación de la probabilidad máxima, no una señal independiente.
   - Hay no-determinismo pequeño.
   - TypeSafe no publica benchmarks estándar.
   - Privacidad: la ZDR se da bajo pedido o en enterprise.
   - Sospechas de que es un Qwen fine-tuneado [especulación].
4. **Gotchas más repetidos:**
   - Ajustar el umbral y no el prompt.
   - Incluir siempre una opción "none of the above".
   - Hacer todas las preguntas en un solo request (fan-out).
   - Cada request lleva ~257 tokens fijos de overhead.
   - El state tiene tope (~30–32k tokens según varios, 64k total según otros) y la precisión cae con ruido.
   - Fijar la versión `jev-1.13.0`.
   - Correr en modo *shadow* antes de aplicar decisiones.

---

## 1. Catálogo de casos de uso y proyectos concretos

### 1.1 Casos en producción o evaluaciones serias con números

| Caso | Qué hace y cómo usa Jev | Diseño de preguntas visible | Resultados reportados | Fuente |
|---|---|---|---|---|
| **Polylane**, agente de on-call | Decide si el agente interviene, la relación entre incidentes, el motivo de cierre de PR, la severidad y la prioridad de recursos cloud. Una semana en producción con `jev-1.13.0`. | Noul "Should the agent follow up on this user message?" con state `{slack_channel,user_message}`. Choice con `criteria` `duplicate_same_root_cause/related/independent`. Choice de 4 niveles sobre una "cohorte" de recursos, para que el juicio sea relativo. | P90 total de 4.752 a 508 ms (−89%) y costo −39%. **No reporta precisión.** | [polylane.com](https://polylane.com/blog/we-swapped-our-llms-for-jev) |
| **Unblocked**, selección de memorias/notas para un agente | Reemplaza el reranker cross-encoder que va detrás de embeddings top-100. | Fan-out: la pregunta va en `state` y hay una Noul por nota ("Note n1 helps answer the question."), en bloques de 20 notas por request. Una request por nota perdió contra el incumbente. | 292 preguntas y 12.927 pares. nDCG@5 +0,048. Con tope de 5 notas, la precisión de lo inyectado pasa de 34,8% a 46,4% y el recall de 63,8% a 77,6%. Costo y latencia, prácticamente empate. | [getunblocked.com](https://getunblocked.com/blog/jev-in-production-vs-cross-encoder/) |
| **Archestra**, anotador IFC de tool calls de Claude Code | Etiqueta cada tool call según audiencia y confianza. | `state={"tool","arguments"}`, varias Choice con `criteria:{trusted,suspicious}`. | Sobre 337 decisiones: Sonnet 5 98%, Jev 93% en 0-shot y 95% con 9-shot. Recall en llamadas peligrosas: Jev 7/9, Sonnet 4/9. Con confianza ≥0,7, 0 errores. La deriva de probabilidad entre corridas llega a 0,17. | [archestra.ai](https://archestra.ai/blog/we-tested-jev-on-100-real-agent-calls) |
| **GitLoom**, resúmenes diarios de GitHub | Categoría del PR (feature/fix/ktlo), si un hilo de review quedó atendido, relevancia para una búsqueda y guardrails anti-invención. | SDK TS `client.systemOne({state, questions:{category: choice(...)}})`, umbral 0,8. | 98,0% de acierto en el 85% de casos en que responde, frente a 88,2% del código anterior (60 PRs). ~6¢ por 1.000 PRs. **El ranking fino no sirvió:** el score se satura en 0,97–0,99. | [gitloom.ai](https://gitloom.ai/blog/jev-in-production) |
| **Southbridge.AI**, entity resolution de donantes electorales (Ohio) | El código arma "átomos" de filas equivalentes. Jev decide si son el mismo donante o el mismo hogar. Luna revisa después. | El criterio vago de "hogar" falló 13/13; reescrito como "misma dirección (número y calle) y personas distintas", acertó 13/13. | Frente a Fable para todo: costo −99,56% (226x menos), throughput 7,35x, precisión a 0,5 pp. Solo con Jev, la precisión "cae significativamente". | [southbridge.ai](https://www.southbridge.ai/blog/jev-entity-resolution) |
| **Vincenzo Iozzo**, resolución de identidades (Okta, AD, GitHub, AWS…) | Una cuenta contra 20 candidatas por request. | Nouls. | F1 0,95, "el mejor de todos los sistemas probados". $0,62 por 1.000 cuentas, 19–47x menos que Haiku 4.5 y Sonnet 5. Mediana 0,3 s. Probabilidades crudas **subconfiadas**. | [vincenzoiozzo.com](https://vincenzoiozzo.com/blog/jev-identity-resolution) |
| **Vega Labs**, gate de triaje de alertas SecOps | Compuerta **unilateral**: solo cierra alertas con "not escalated" >0,8 y usa como state el historial del tenant. | Choice. | Cerró 15–33% de las alertas con ~98% de acierto. Con umbral 0,9 no se escapó ninguna escalación. **Como decisor completo solo coincidió 42–69%.** | [labs.vega.io](https://labs.vega.io/blog/bubble-sheets-for-secops/) |
| **Nym**, agente de consumo | Reemplazó 7 revisores con Gemini Flash Lite: aprobaciones, liberación de credenciales, checkout, abuso y memoria. Los límites de gasto siguen en código. | Si Jev está inseguro se toma una observación nueva; si sigue inseguro, cae a DeepSeek. | 4,1–5,7x más rápido. 167/167 frente a 160/167 en un set propio. | [usenym.com](https://usenym.com/technical-blog/rebuilding-our-agent-with-jev) |
| **Bolna**, agentes de voz en hindi/hinglish | 3 tareas contra 17 modelos. | Probaron 6 rediseños de la request. | **Ruteo de nodos: 72,7%, 8.º de 10.** El agente se queda "atascado" y ningún rediseño lo mejoró. Juez de llamadas: empate con Qwen3-32B/Gemma 4 a 383 ms. Extracción de 23 campos en 1 request: grupo top con Gemini y Sonnet. | [bolna.ai](https://www.bolna.ai/blog/testing-jev-on-real-phone-calls) |
| **CraftCX**, etiquetas de tickets | Resolución, urgencia, brecha de documentación y sentimiento. Los resúmenes siguen en un LLM. | — | Recall macro de 79,3% a 95,6%, costo −93% y tiempo de 92 s a 5,8 s. Sobre **16 conversaciones sintéticas**. | [craftcx.com](https://craftcx.com/blog/moving-support-decisions-to-jev) |
| **r6i**, taxonomía de productos | Descenso por el árbol de categorías con un Choice por nivel. | "Speculative fan-out": pregunta por el nivel actual y por los hijos en la misma request. | Latencia de 9,6 s a 1,4 s y 72% de rutas idénticas. El agente gana donde hace falta backtracking. Los tokens de output crecen 383%. | [blog.r6i.it](https://blog.r6i.it/typesafe-jev-vs-agentic-loop.html) |
| **Tessl**, verificadores de tests | 2.725 tests. | — | 13,6x más rápido, 2,7x más barato y 85,9% de acuerdo con GPT Luna 6. Lo cita un empleado en HN; **el blog no cargó** [no verificado]. | [HN](https://news.ycombinator.com/item?id=49821632), [tessl.io](https://tessl.io/blog/jev-is-136x-faster-and-27x-cheaper-than-gpt-luna-6-for-tessl-verifiers) |
| **MotherDuck**, `prompt_jev()` en SQL | Función escalar que devuelve un struct con `.choice` y `.confidence`. | `choice := [{label, description}]` | 100.000 filas de AG News en 40 s por $0,50, frente a >30 min y $37 de un LLM frontier con precisión similar. | [motherduck.com](https://motherduck.com/blog/motherduck-supports-jev/) |
| **Jesse Bounds**, inbox zero (Gmail + Notion) | Reemplazó un prompt de 26k tokens con 13 reglas por una Noul por regla. | Umbral 0,5; plantea 0,8 para "urgente". | En 40 mensajes, set exacto de etiquetas: Jev 37, Luna 28. Por 1.000 mensajes: $0,13 frente a $7,20 de Haiku. | [bounds.dev](https://www.bounds.dev/posts/automated-inbox-zero-with-notion-agents-and-jev/) |
| **lindfors.no**, consulta pública noruega (acceso anticipado) | Postura, tipo de remitente, argumentos y "sustancia" en 24 documentos en noruego. | 11 preguntas por documento en 1 request: Choice, Noul y Score 0–3. | Medio centavo en total, frente a 7¢ y 47k tokens de razonamiento de DeepSeek. Buena calibración en 192 juicios. | [lindfors.no](https://lindfors.no/blog/a-first-look-at-typesafes-jev/) |
| **Near Here**, validar eventos locales | Después de los filtros deterministas, decide si el listado es un evento válido o una de varias razones de rechazo. | Choice. | En 50 casos: Jev 96%, $0,043 por 1.000. Gemini Flash-Lite 86%, Mistral Small 84%. Los mismos casos sirvieron para elegir el prompt. | [nearhere.events](https://nearhere.events/blog/typesafe-jev-mistral-gemini-event-validation) |
| **Kiln AI**, pinyin de caracteres polifónicos | Un loop de "autoresearch" optimiza el harness, no el modelo. | — | 147 errores frente a 285 de un modelo con razonamiento, 7x más barato y <300 ms. La campaña completa costó ~$18. | [kiln.tech](https://kiln.tech/blog/auto_optimizing_jev_with_autoresearch) |
| **Remy Wang**, CSV mal formados | Solo se llama a Jev cuando falla el parser estricto: una Noul por coma, "¿es separador?". | 14 caracteres a cada lado y muestras de columna en el state. | 98% de decisiones correctas, pero solo 27–85% de filas completas correctas. 8¢ por 12.044 decisiones. | [remy.wang](https://remy.wang/blog/jev-csv.html) |
| **Evan Schwartz**, Scour (feed personalizado) | 54 preguntas (50 Noul, 3 Choice, 1 Score) sobre ~1,1M documentos al mes. | Un post por request, siguiendo la doc. | <$150 al mes, pero ~88% del input son las preguntas reenviadas en cada request. Pide prompt caching. | [emschwartz.me](https://emschwartz.me/please-add-prompt-caching-to-jev-style-models/) |
| **Tyrpien / Oko**, búsqueda de código (MCP) | ripgrep + BM25 dan 30 chunks; Jev puntúa los 30 en 1 llamada (~0,5 s). | — | Claude Code 31%, Codex 18% y OpenCode 15% más rápidos, con 20–42% menos tokens. **Solo mejoró al poner una regla de "cuándo parar de buscar" en AGENTS.md.** | [tyrpien.com](https://tyrpien.com/blog/oko-agent-search) |
| **Columnar / Jevaro**, proxy Arrow | Muchos states con un mapa de preguntas compartido, respuesta en stream Arrow IPC. | Choice de departamento, Score de urgencia, Noul de reembolso. | 10.000 mensajes en 21,5 s (~464 states/s). | [columnar.tech](https://columnar.tech/blog/what-if-jev-spoke-arrow/) |
| **kyotofin/tax-doc-classifier** (483★) | Clasifica páginas entre 261 formularios del IRS. | Criterios generados de los PDFs del IRS; gate `formConfidence >= 0.95`. | "100% strict accuracy", ~$0,001 por página, 34x más barato que su pipeline LLM. | [GitHub](https://github.com/kyotofin/tax-doc-classifier) |
| **Paper Radar** (Reddit) | Filtra todo arXiv. | Varias Noul por paper en 1 llamada; la media geométrica de criterios funcionó mejor que el mínimo. | 501 papers en 33 s por $0,0196. En CLEF TAR 2019: 96,9% de recall y 78% menos trabajo. | [r/learnmachinelearning](https://www.reddit.com/r/learnmachinelearning/comments/1wozkgj/) |
| **24.000 transcripciones** (comentario en Reddit) | Clasificación masiva. | — | ~7,5M decisiones por ~$75, "~10x más barato que Haiku en la práctica" porque el tokenizador gasta 2–3 tokens por palabra. "Lo caro fue validar." | [Reddit](https://www.reddit.com/r/ClaudeAI/comments/1wm83ts/where_jev_can_take_work_off_claude_and_where_it/pb5bw1n/) |
| **pi-warden**, guardrail del agente Pi | 4 preguntas por cada bash/write/edit: irreversible, fuera de tarea, modifica, alcance. | — | 42 comandos retenidos en 17.000 llamadas, ~88% de retenciones correctas, ~250 ms. Resumen en dev.to; **el post original de Reddit no lo leí** [no verificado]. | [dev.to](https://dev.to/minh-leduc/pi-warden-using-jev-to-block-destructive-commands-in-48-hours-caj) |
| **jevmem**, memoria para Claude Code/Cursor/Codex | Jev decide qué guardar en `JEVMEM.md` y qué queda obsoleto. | — | En 66 mensajes: save/skip 98,5% (empate con Astra), mediana 0,30 s, $0,000127 por decisión. Está en el directorio de plugins de Claude. | [HN](https://news.ycombinator.com/item?id=49846413), [GitHub](https://github.com/Avinash-jetwani/jevmem) |
| **Doblaje en tiempo real (iPhone)** | Jev decide si una frase traducida está completa para emitirla. | — | ~0,35 s por decisión, ~2¢ por hora de audio. El segmento retenido más largo fue de 17 s, frente a 40 s con DeepSeek. | [HN](https://news.ycombinator.com/item?id=49814743), [HN](https://news.ycombinator.com/item?id=49814753) |

### 1.2 Proyectos de código abierto destacados (GitHub)

Estrellas al 29-09. Las cifras son de los autores.

- **Agentes de navegador y escritorio:**
  - [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) (21k★): Jev elige la operación (CLICK/TYPE_TEXT/SCROLL/DONE/BLOCKED) y el elemento. Las preguntas de target son especulativas, así que hay 2 decisiones por round trip. Un LLM pequeño solo escribe el texto. Dicen hacer "Zürich → London en Google Flights en 7,1 s".
  - [awlevin/typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use) (1,1k★): maneja un Mac. OCR y accesibilidad se convierten en state, y un Choice de hasta 255 acciones decide. $0,0002 por decisión frente a $0,032 de Opus 5. Advierte que el razonamiento (comparar fechas) hay que hacerlo en código.
  - trycua/cua tiene un adaptador en `libs/cua-driver/examples/jev-use`. En CUA-S1, Jev hosted sacó 83,6% frente a 99,7% de un modelo especialista en formularios ([HN](https://news.ycombinator.com/item?id=49767564)).
- **Hooks y plugins para agentes de código:**
  - [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (7,2k★): reemplaza el resumen de compactación de Claude Code. Jev puntúa cada tool call o resultado, se borran los obsoletos y el resto se conserva literal.
  - [tamaratran/jev-pruner](https://github.com/tamaratran/jev-pruner): recorta stdouts de Bash de más de 10k tokens.
  - [dzhng/jevgrep](https://github.com/dzhng/jevgrep) (1,8k★): "find code by asking what it does". En 10 tareas de SWE-bench completó las mismas 8/10 a ~30% menos costo.
  - [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router) y [0xNatoshi/jev-codex-router](https://github.com/0xNatoshi/jev-codex-router): eligen modelo y esfuerzo por turno. El segundo estima "≈−60% vs Astra" en una simulación, no en cuota medida.
  - [philippdubach/pi-jev-router](https://github.com/philippdubach/pi-jev-router): una llamada con 5 preguntas (category, complexity, risk, brief, decompose) que rutea por frontera de Pareto en OpenRouter. Viene en **modo shadow por defecto** y se abstiene si "brief needs clarification" ≥0,7.
  - [jomatsu/pi-jev-auto-mode](https://github.com/jomatsu/pi-jev-auto-mode): primero una capa determinista y luego un juicio de Jev. Fail-closed.
- **Revisión de código y CI:**
  - [egma-ai/jev-code-reviewer](https://github.com/egma-ai/jev-code-reviewer): clasifica cambios en P0/P1/P2.
  - [metalbear-co/jev-auto-approve](https://github.com/metalbear-co/jev-auto-approve): GitHub Action con 3 Nouls ("¿listo?", "¿cubierto por tests?", "¿requiere humano?"). Aprueba solo si todas pasan y, si no, comenta qué pregunta lo frenó.
  - [zdenham/jev-lint](https://github.com/zdenham/jev-lint): linter con reglas en inglés llano.
- **Seguridad y guardrails:**
  - [agent-chaperone](https://github.com/agent-chaperone/agent-chaperone): firewall de tool calls e inyección indirecta que envuelve servidores MCP. InjecAgent AUC 0,976. 8 falsos positivos en 68 textos benignos que *hablan de* inyección.
  - [luantak/is-malicious](https://github.com/luantak/is-malicious): escanea repos buscando exfiltración. Advierte: "A clean report is not proof that a project is safe."
- **Evals:**
  - [openlayer-ai/jevals](https://github.com/openlayer-ai/jevals): sustituye al LLM judge. $0,03 frente a $2,60 de Ragas por 1k muestras, p50 244 ms.
  - DeepEval "JevEval" ([deepeval.com](https://deepeval.com/blog/introducing-jev-as-a-judge)).
- **Email:**
  - [albertcas/jev-mail-filtering](https://github.com/albertcas/jev-mail-filtering): cliente local de solo lectura con 9 preguntas por email. Las señales SPF/DKIM/DMARC y los links discordantes se calculan en código y van en `state.signals` "as facts verified by software". Hay una política pura en código y sliders de umbral **sin volver a llamar a Jev**. 100% en 50 emails ficticios del autor, que advierte que en bandejas reales esperes menos.
  - [az9713/jev-email-triage](https://github.com/az9713/jev-email-triage): 90 días de bandeja real vía Vercel AI Gateway con 4 preguntas (category de 7 opciones, importance 0–5, brand_deal, scam). ~$0,00003 por email. Documenta "4 mis-ranks".
- **Bases de datos:**
  - [realZachi/pg-jev](https://github.com/realZachi/pg-jev) (Postgres): `jev()`, `jev_choice`, `jev_score`.
  - [colliber/duckdb-jev](https://github.com/colliber/duckdb-jev): el criterio define el ENUM de la columna.
  - [maayanlevy/mysql-ailike](https://github.com/maayanlevy/mysql-ailike): operador `AILIKE`. Recomienda filtrar antes con SQL.
- **Documentos:** [jerryjliu/docjev](https://github.com/jerryjliu/docjev), clasificación y partición de paquetes PDF/DOCX.
- **Hogar:** [AboveColin/HA-Jev](https://github.com/AboveColin/HA-Jev), Home Assistant con preguntas como sensores, presupuesto diario de tokens y 25 blueprints.
- **Trading:**
  - [jarrodwatts/jev-trader](https://github.com/jarrodwatts/jev-trader): market maker en Monad con decisión cada ~300 ms. El deploy público va en dry-run.
  - [OpenByteInc/QuantDinger](https://github.com/OpenByteInc/QuantDinger): gate de Jev antes de las órdenes de entrada, fail-open; las salidas nunca pasan por la IA.
- **CLIs Unix:** [fabianboth/jevpipe](https://github.com/fabianboth/jevpipe), [vsekhar/decide](https://github.com/vsekhar/decide) y onesie ([HN](https://news.ycombinator.com/item?id=49876472)).
- **Listas curadas:**
  - [Amal-David/awesome-jev](https://github.com/Amal-David/awesome-jev): advierte que "Source review is not a runtime test or a security audit".
  - [logicrw/awesome-jev-projects](https://github.com/logicrw/awesome-jev-projects): 799 proyectos. La categoría más grande es "SDK & Decision Frameworks", con 130.
  - Directorios web: [madewithjev.com](https://madewithjev.com), [jevable.com](https://jevable.com/) y [jevtypesafeai.com/use-cases](https://jevtypesafeai.com/use-cases/). Este último es un playground **independiente, no oficial**, con 18 recetas: model-routing, tool-risk-gate, context-compaction, agent-done-check…

### 1.3 Benchmarks independientes

| Benchmark | Resultado | Fuente |
|---|---|---|
| 770 posts de r/AmItheAsshole | Jev 2.º detrás de Sonnet 5 en Brier (0,369 contra 0,344). Mediana 6,3x más rápida y 62x más barata, "no los 40–200x anunciados". Contra el reparto de opiniones, Jev sin ajustar "no longer clearly beats guessing from base rates". | [dchristopoulos/jev-aita](https://github.com/dchristopoulos/jev-aita) |
| 10 suites, 9 modelos | CT1-8: Jev 98,84%, Haiku 96,46%, Sonnet 96,18%, a $0,031 por 1k llamadas. Débil en aritmética cerca de un umbral (9,3% de error, aunque los Claude fallan más). | [YidiDev/jev-benchmark](https://github.com/YidiDev/jev-benchmark) |
| Code review, 1.080 llamadas | 45x más barato que Gemini Flash, pero 98% de corrección frente a 100%, y **0,83% de decisiones cambian entre rondas** (0% en los otros). | [gemanor/jev-code-review-benchmark](https://github.com/gemanor/jev-code-review-benchmark) |
| CVSS, 2.449 hallazgos | **7.º de 8** (MAE 3,40). 550 "critical" donde la referencia tenía 55. Mantuvo el 90,9% de los críticos reales. | [casco.com](https://casco.com/blog/jev-cvss-benchmark) |
| Detección de jailbreak (1 Noul fija) | Mejor AUC (0,937) frente a PIGuard, Prompt Guard 2 y otros, sin entrenamiento específico. | [backnotprop.com](https://backnotprop.com/blog/jev-guardrails/) |
| Spam bajo ataque (16.079 llamadas) | Con reglas básicas el ataque funcionó 26,8% de las veces; con "revisa cada parte", 0%. En un test de 1.056 ataques, Jev falló 0,09%. | [tanh.xyz](https://tanh.xyz/research-notes/jev-prompt-manipulation) |
| Poker (TexasSolver) | 33–44% de acierto en spots de acción, pero la regla trivial "check/call" (72%) le gana en el total. La misma request varía entre 0,59 y 0,65. | [backnotprop.com](https://backnotprop.com/blog/jev-poker/) |
| 8 datasets contra ML clásico | IMDb 96,3 y SMS Spam 96,1 (mejores). Banking77 78,9 frente a 89,7 de un SVM. **Tabulares ~50–61% (azar).** | [quicqdev](https://quicqdev.github.io/Jev-vs-ML/) |
| FewRel, extracción de relaciones | Jev 87,5% a 431 ms, frente a DeepSeek 93,1% a 1.242 ms. | [r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/comments/1wm2fpf/) |
| Transacciones bancarias (regulación alemana) | Jev 40,7%, Gemma-2-2b fine-tuneado 85,3%. "Básicamente inútil para este caso." | [X @kris_cvetko](https://x.com/kris_cvetko/status/2101614168763695308) |
| Jev contra Kev 4B, 362 ítems nuevos | Precisión a menos de 2 pp. Jev mucho mejor calibrado (ECE 0,027–0,049 frente a 0,125–0,137) y gana en PAWS (87,0 frente a 74,5). | [opper.ai](https://opper.ai/blog/jev-vs-kev-open-decision-model) |

---

## 2. Opiniones y críticas en foros

### 2.1 Elogios

- **Costo y velocidad.** "Classifying 1000 yelp reviews used to cost $50. Now it costs 5¢, at similar accuracy" ([momojo](https://news.ycombinator.com/item?id=49797152)). "~1.5bn tokens is about $40" ([mtkd](https://news.ycombinator.com/item?id=49848958)). El precio "Insane" ([wxw](https://news.ycombinator.com/item?id=49718719)). Costo predecible porque solo cobra input ([Pranav_Ghoghari](https://news.ycombinator.com/item?id=49774568)).
- **Diseño de la API.** "the API is very well designed for classification" ([softwaredoug](https://news.ycombinator.com/item?id=49818856)). "fast, cheap, bounded, probability-bearing result designed to be consumed directly by software" ([Jemaclus](https://news.ycombinator.com/item?id=49872751)). "structured I/O and confidence scores are game changing" ([lubujackson](https://news.ycombinator.com/item?id=49718626)).
- **Pone el ML al alcance sin presupuesto.** Un DevOps nunca tendría presupuesto para un clasificador a medida, pero sí para una llamada API ([ygouzerh](https://news.ycombinator.com/item?id=49812436)). Una organización probó clasificadores en varios sistemas "con casi cero ingeniería" ([shaewest](https://news.ycombinator.com/item?id=49886437)). En investigación cualitativa clasificaron miles de respuestas al instante ([effisfor](https://news.ycombinator.com/item?id=49868483)).
- **Mejor que los clones abiertos en tareas reales.** "it's not close. The benchmarks are a misrepresentation" ([jasonjmcghee](https://news.ycombinator.com/item?id=49809597)). Jev 98% frente a Laya 15% en un dataset sintético ([mkrishnan](https://news.ycombinator.com/item?id=49821344)). Jev 94% frente a Jeff 70% ([AgentMasterRace](https://news.ycombinator.com/item?id=49884862)). "all the open source me too Jevs... they all suck" ([zergrush](https://news.ycombinator.com/item?id=49887110)). En historial de git: Jev 74–81% frente a SemIf 52–64%, y Von y Laya "colapsan" ([r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/comments/1wntc8m/)).
- **Como complemento de un LLM, no como reemplazo.** "works incredibly well in concert with LLMs, not as a replacement" ([tylermarques](https://news.ycombinator.com/item?id=49718890)). "Jev no le ganó a Claude; me hizo ver cuánto uso Claude de más" ([u/Intrepid_Truth8898](https://www.reddit.com/r/ClaudeAI/comments/1wpq62p/)). "Jev es el CLIP de los LLM" ([u/you-get-an-upvote](https://www.reddit.com/r/singularity/comments/1wqs5d9/is_jev_worth_the_hype/pcqv4yc/)).
- **Prototipado.** Usarlo "como LangChain": prototipar rápido y reemplazarlo por algo propio si funciona ([boostermodule](https://news.ycombinator.com/item?id=49806797), [sanderjd](https://news.ycombinator.com/item?id=49808709)). Cambiar lo que clasificas editando un prompt, sin reentrenar ([pushpendraw](https://news.ycombinator.com/item?id=49808268)).
- **Contra el argumento de que no aporta nada nuevo.** "Fast and accurate general purpose classifiers DID NOT EXIST before Jev" ([baobabKoodaa](https://news.ycombinator.com/item?id=49814099)). "You could send text before Twilio" ([zer00eyz](https://news.ycombinator.com/item?id=49806769)). "tienen el mejor clasificador zero-shot, servido a escala; lo que cuenta es la ejecución" ([u/LocoMod](https://www.reddit.com/r/LocalLLaMA/comments/1woe70t/jev_isnt_new_tech_its_marketing_targets_people/pbmgxyh/)).

### 2.2 Escepticismo y críticas

- **"Can't hallucinate" es engañoso: puede estar "confidently wrong".** Lo señalan [StevenWaterman](https://news.ycombinator.com/item?id=49723111), [thduabmd](https://news.ycombinator.com/item?id=49720703) y [tanh.xyz](https://tanh.xyz/research-notes/jev-prompt-manipulation) ("con dos opciones, ALLOW y BLOCK satisfacen ambas el esquema"). El CEO lo admite: "it's also possible to be confidently wrong" [STAFF] ([item](https://news.ycombinator.com/item?id=49718780)).
- **Calibración:**
  - "Jev can't be calibrated" para todos los usuarios a la vez: la calibración depende de tu distribución, así que hay que recalibrar con Platt scaling ([alexmolas.com](https://www.alexmolas.com/2026/09/23/jev-cant-be-calibrated.html)).
  - Dado justo oculto: elige "1" las 400 veces con 0,83 de probabilidad y acierta 19%. Un documento que dice "30% de riesgo" se convierte en 5% vía Choice ([kantahayashiai](https://kantahayashiai.github.io/posts/jev-does-not-play-dice/)).
  - En sentido contrario, [Grazian](https://leonardgrazian.com/blog/jev-calibration/) mide ECE ~0,025, pero **con prompts ya afinados**. [lindfors](https://lindfors.no/blog/a-first-look-at-typesafes-jev/) y [Opper](https://opper.ai/blog/jev-vs-kev-open-decision-model) también reportan buena calibración.
- **`confidence` es redundante.**
  - En Choice es `(N·p_max − 1)/(N − 1)`, una transformación de la probabilidad máxima ([kantahayashi](https://news.ycombinator.com/item?id=49815455), [bernoulli.app](https://bernoulli.app/articles/is-jev-confident), [jkudish/jev-mcp#29](https://github.com/jkudish/jev-mcp)). Según bernoulli.app, el CTO confirmó las fórmulas en un gist.
  - Como señal es peor que la probabilidad máxima: ECE 0,19 frente a 0,12 ([dev.to/harrisonsec](https://dev.to/harrisonsec/jev-ships-two-confidence-numbers-the-api-hands-you-the-worse-one-5ggl)).
- **No es determinista.**
  - Archestra: deriva de hasta 0,17, y reordenar criterios cambia ~4/100 decisiones de 3 opciones.
  - Southbridge: ~1% de decisiones se invierten al reintentar ([southbridge.ai](https://www.southbridge.ai/blog/jev-watching-the-agents)).
  - Reordenar las opciones cambia las probabilidades ([hbrn](https://news.ycombinator.com/item?id=49802997), [selcuka](https://news.ycombinator.com/item?id=49886608)).
- **"Es solo un clasificador zero-shot con marketing":**
  - Lo dicen [gok](https://news.ycombinator.com/item?id=49718561), [gwern](https://news.ycombinator.com/item?id=49807151) (OpenAI ya tuvo una API de clasificación zero-shot) y [u/tiensss](https://www.reddit.com/r/LocalLLaMA/comments/1woe70t/). Este último cita BGE-small + regresión logística con 93,3% en BANKING77 frente a 83,2% de Jev.
  - Posts de "hazlo tú mismo": "Jev in 25 lines of Python", con logits de Qwen3-0.6B ([nobodywho.ai](https://www.nobodywho.ai/posts/jev-in-25-lines/), 691 puntos en HN), y [Sean Goedecke](https://www.seangoedecke.com/jev-means-structured-output-is-interesting-again/), que habla de "semantic dodge" y "no hay moat técnico sustancial".
- **Benchmarks.**
  - TypeSafe no publica benchmarks estándar: "I bet they would publish them if their score... were good" ([jceg](https://news.ycombinator.com/item?id=49718242)).
  - Los ToS parecen restringir hacer benchmarks ([andriy_koval](https://news.ycombinator.com/item?id=49794308), [tomrod](https://news.ycombinator.com/item?id=49809120)). **No verifiqué los ToS directamente.**
  - El eval del lanzamiento compara contra el promedio de Astra y Fable, no contra ground truth ([zmmmmm](https://news.ycombinator.com/item?id=49719329), [u/prakersh](https://www.reddit.com/r/ClaudeAI/comments/1wm83ts/)).
  - DataCamp cita 67,8% de acuerdo, 5–6 puntos por debajo de los modelos insignia ([datacamp](https://www.datacamp.com/blog/typesafe-jev-vs-gpt-6-astra)).
- **Las cifras de 200x/444x.** Medido en carga real salió 12x más rápido en la mediana (~3x ajustando) y 7x más barato, y el ahorro viene de que el output es gratis, no del precio por token ([dev.to/devopsdaily](https://dev.to/devopsdaily/we-measured-the-200x-claim-and-got-it-wrong-twice-first-5ch5)). Con una sola etiqueta cuesta lo mismo que Qwen3.8 Flash o GLM Flash sin thinking ([dev.to/synthorai](https://dev.to/synthorai/jev-vs-flash-llms-7x-cheaper-on-workflows-same-cost-on-one-label-1e2j)).
- **Privacidad y dependencia de un proveedor:**
  - Retención de datos: "completely draconian" ([prodigycorp](https://news.ycombinator.com/item?id=49788533)).
  - La ZDR se concedió por email en una hora ([shaewest](https://news.ycombinator.com/item?id=49808200)) o está disponible por llamada vía Vercel ([_puk](https://news.ycombinator.com/item?id=49805793)).
  - No está en Bedrock, y OpenRouter o Cloudflare solo hacen de proxy ([oscarfr](https://news.ycombinator.com/item?id=49789126)).
  - jevmem manda todas tus conversaciones a "a young vendor" ([qwertox](https://news.ycombinator.com/item?id=49846649)).
  - Riesgo de proveedor único ([kouteiheika](https://news.ycombinator.com/item?id=49863747)).
- **Astroturfing:** cuentas nuevas que solo hablan de Jev ([GodelNumbering](https://news.ycombinator.com/item?id=49803790), [arbayi](https://news.ycombinator.com/item?id=49724185), [u/ithinkitslupis](https://www.reddit.com/r/LocalLLaMA/comments/1wm65le/i_really_dont_understand_jev_hype/pb4eybr/), "30 posts al día"). Un moderador de r/LocalLLaMA explica su criterio de borrado ([u/ttkciar](https://www.reddit.com/r/LocalLLaMA/comments/1wo6o0f/mods_can_we_do_something_about_half_the_forum/pbm9url/)).
- **Origen del modelo.** Con el alfabeto como choices, Jev "dice" que es Qwen ([mohsen1](https://news.ycombinator.com/item?id=49785351), [ouijev.com](https://ouijev.com/?q=Are+you+a+qwen+model)). Sobre Taiwán, un usuario lo interpreta como señal de base china ([Reddit](https://www.reddit.com/r/LocalLLaMA/comments/1wlnl01/)). **Todo esto es [especulación]; nadie lo ha probado.** Hay además una disputa de prioridad con Laya, que dice haber publicado la arquitectura en 2025 ([r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/comments/1wijo3e/)).
- **Opacidad y sesgo.** Es una regresión a la caja negra: devuelve un float sin justificación. En su prueba de "¿buena ciudad?" del Bay Area, Cupertino queda arriba y East Palo Alto abajo. Pide que no se use para rankear candidatos a empleo ([Simon Willison](https://simonwillison.net/2026/Sep/21/jev/)).
- **Marca.** "TypeSafe" se confunde con Typesafe/Akka y con TypeScript ([dinobones](https://news.ycombinator.com/item?id=49718973)). "Noul" es un neologismo sin explicar ([sedev](https://news.ycombinator.com/item?id=49772659)); según Willison, el CEO dijo que viene de Bernoulli.
- **No es drop-in.** Hay que rediseñar los sistemas, por ejemplo los de LangGraph ([activehuman](https://news.ycombinator.com/item?id=49721114)).
- **Moat.** OpenAI puede copiarlo ([arcturus-labs](https://arcturus-labs.com/blog/2026/09/21/will-openai-eat-jevs-lunch/), 328 puntos). El 29-09 OpenAI anunció una "Decision API" sobre Luna ([thenewstack](https://thenewstack.io/openai-decision-api-luna/)).

### 2.3 Reportes de fallos

- **Ruteo:**
  - Bolna: 72,7% en ruteo de nodos de voz, y el agente se queda "atascado" ([bolna.ai](https://www.bolna.ai/blog/testing-jev-on-real-phone-calls)).
  - Weave: en ruteo de modelos para agentes de código, sin estado de sesión "espera algo cercano al baseline de clase mayoritaria, solo que 200x más rápido" ([weaveos.com](https://weaveos.com/blog/why-you-shouldnt-use-jev-for-coding-agents-and-routing)).
  - jev-gate: "no se estableció ahorro" ([Reddit](https://www.reddit.com/r/ClaudeAI/comments/1wt086x/)).
- **Router de skills para Claude Code, en modo solo-log durante una semana.** Jev eligió una skill en 539 de 1.242 juicios, y Claude la usó solo 28 veces (~5%). El autor quitó los plugins: Jev "se mide bien en pipelines de flujo fijo, no en agentes que deciden sobre la marcha" ([dev.to/shimo4228](https://dev.to/shimo4228/is-there-any-point-to-this-removing-the-jev-plugins-i-added-to-claude-code-after-one-week-49eh)).
- **Formularios.** El híbrido Jev + Sonnet salió 2,7x más lento y 1,9x más caro que Sonnet + Playwright. La primera medición ("5000x más barato") ocultaba un plan escrito a mano. "Jev no planifica" ([Reddit](https://www.reddit.com/r/ClaudeAI/comments/1wj3lsw/)).
- **Química.** No genera SMILES carácter a carácter: produce "CCCCCCCCCC". Aprobó con 87% una inversión estereoquímica no autorizada ([frederickparsons](https://frederickparsons.substack.com/p/can-a-fast-ai-gate-catch-chemistry)).
- **Juegos:**
  - Ajedrez: "blunders pieces on every move" ([haute_cuisine](https://news.ycombinator.com/item?id=49770148)).
  - Exploración de un mapa de 6 cuartos: siempre elige la primera opción ([ranyume](https://news.ycombinator.com/item?id=49787103)).
  - Laberintos básicos: no los resuelve ([budro](https://news.ycombinator.com/item?id=49743854)).
  - Pokémon Red: sin harness "never left Pallet Town". La versión que termina el juego (~38 h, $1,65) trae A*, 33 objetivos hardcodeados y opciones anotadas "toward the objective" ([hbrn](https://news.ycombinator.com/item?id=49857575), [HN](https://news.ycombinator.com/item?id=49864073)).
  - Doom: 1,13 kills, frente a 3,63 de un Qwen con LoRA ([r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/comments/1wl1yzq/)).
- **Contexto y listas largas.** El límite de 32k impidió evaluar code reviews ([nickstinemates](https://news.ycombinator.com/item?id=49720694)). "starts to break down once you go over 20 classifications" ([EagnaIonat](https://news.ycombinator.com/item?id=49805115)).
- **Seguridad adversarial.** Es "fácil" colar comandos dañinos con hex o Python: sirve contra errores honestos, no contra intención hostil ([southbridge.ai](https://www.southbridge.ai/blog/jev-watching-the-agents)). Un prompt injection simple dio "95% Yes" en un harness ([lanyard-textile](https://news.ycombinator.com/item?id=49804711)), aunque la interpretación es ambigua.
- **Detector de "AI slop".** Un keysmash salió 86% IA; "as handy as a coin flip" ([HN](https://news.ycombinator.com/item?id=49810063), [hbrn](https://news.ycombinator.com/item?id=49818853)).
- **Priors.** No tiene opción de "no information": con un state irrelevante no da priors razonables ([amluto](https://news.ycombinator.com/item?id=49839995)). Si le das una opción "not sure", la elige el 100% de las veces ([edot](https://news.ycombinator.com/item?id=49818077)).
- **SimpleQA.** Jev ordena bien los pasajes (AUROC 0,926), pero el pipeline completo empeora (0,612 frente a 0,740) porque declina demasiadas preguntas ([r/LocalLLaMA](https://www.reddit.com/r/LocalLLaMA/comments/1wmkr01/)).

### 2.4 Comparaciones

- **Contra LLMs:**
  - En batch offline, GPT-6 Luna con 20 registros por prompt salió 1,6x más barato con rendimiento equivalente ([CharlieDigital](https://news.ycombinator.com/item?id=49821799)).
  - En spam, Luna salió 20% más barato gracias al prompt caching ([zihotki](https://news.ycombinator.com/item?id=49892718)).
  - 10.000 tickets con DeepSeek Flash cuestan <$1 ([jubilanti](https://news.ycombinator.com/item?id=49886699)).
  - DeepSeek V4.1 Flash da algo más de acuerdo y es solo 2,6x más caro en un estudio de early access ([kevmo314](https://news.ycombinator.com/item?id=49722960), [lostmsu](https://news.ycombinator.com/item?id=49769544)).
  - LLM con constrained decoding: el CEO dice que "make models dumber" [STAFF] ([item](https://news.ycombinator.com/item?id=49718849)).
  - Los logprobs de los modelos frontier están mal calibrados o rotos ([ainch](https://news.ycombinator.com/item?id=49813152), [armcat](https://news.ycombinator.com/item?id=49814490)).
- **Contra embeddings + regresión logística:** igualan o superan a Jev y Laya en clasificación básica (AG News, Banking77…) pero pierden en XNLI, que requiere razonamiento ([nico](https://news.ycombinator.com/item?id=49790206)). semlabel dice ser "20-30x faster than Jev" ([visarga](https://news.ycombinator.com/item?id=49820835)). "You don't need Jev for good emoji search" ([maxleiter.com](https://maxleiter.com/blog/embedding-emoji-search)).
- **Contra clasificadores fine-tuneados:**
  - ModernBERT pasa de 30% a 98,2% con fine-tune ([constantlm](https://news.ycombinator.com/item?id=49793062)).
  - Qwen2.5-1.5B con LoRA saca 94,6% frente a 68,1% de Jev en una taxonomía propia ([Reddit](https://www.reddit.com/r/LocalLLaMA/comments/1wmyvzp/)).
  - Un encoder de 310M con 250 etiquetas le saca +12 pp en japonés ([dev.to/ikkun1222](https://dev.to/ikkun1222/jev-vs-a-310m-encoder-i-trained-myself-750-rows-three-tasks-two-different-winners-242e)).
  - En fraude tabular, XGBoost le ganaría: "I need an accurate one" ([edot](https://news.ycombinator.com/item?id=49725737)).
- **Contra clones open-source:** ver §3.4. En resumen, según sus autores algunos igualan a Jev en benchmarks públicos, pero los usuarios reportan brechas grandes en tareas reales. En JevBench la diferencia entre el set público y el sellado es grande para todos (Jev 86,6% contra 36,7%) ([jonmagic](https://news.ycombinator.com/item?id=49849014), [JevBench](https://benchmarkheaven.com/jev-models)).

---

## 3. Integraciones y ecosistema

### 3.1 SDKs

- **Oficiales:**
  - Python: `typesafe_sdk` (`Choice, Noul, Score, TypeSafeClient`).
  - JS/TS: `@typesafe-ai/sdk`.
  - Skill para agentes: `typesafe-ai/skills` y [docs.typesafe.ai/agent-skill](https://news.ycombinator.com/item?id=49788807).
  - Hay un fork de DSPy hecho por staff: [dspy-typesafeify](https://news.ycombinator.com/item?id=49719285) [STAFF].
- **De la comunidad:**
  - Java: [QAInsights/typesafe-java-sdk](https://github.com/QAInsights/typesafe-java-sdk), [maxsumrall/jev4j](https://github.com/maxsumrall/jev4j), con `Jev.choice(Team.class, …)` dentro de un `switch` exhaustivo, y el SDK de jamilxt ([dev.to](https://dev.to/jamilxt/i-built-the-first-java-sdk-for-jev-typesafes-system-one-model-2m37) y [Medium](https://medium.com/@jamilxt/i-built-the-first-java-sdk-for-jev-typesafes-system-one-model-858ab9f94263)). Este último evitó a propósito el ChatModel de Spring AI "porque es autoregresivo".
  - Spring AI Community: `spring-ai-starter-typesafe` ([spring.io](https://spring.io/blog/2026/09/21/spring-ai-typesafe-structured-judgment/)).
  - Ruby: [innocentdiaz/typesafe_ruby](https://github.com/innocentdiaz/typesafe_ruby).
  - Elixir: dannote/jev ("Clause order is the routing. Thresholds are guards").
  - Rust: luizribeiro/jevrs.
  - Go, Kotlin, C# y Swift: los vi solo en listas awesome [no verificado].

### 3.2 Gateways y proveedores

- **Vercel AI Gateway** (`typesafe-ai/jev`):
  - Es el que más aparece en los repos.
  - En el AI SDK se usa `experimental_evaluate` y la confianza viene en `providerMetadata.typesafe.confidence`.
  - Según az9713, el tier gratuito limita Jev a pocas llamadas.
  - Fuentes: [vercel.com/i/jev-integrations](https://vercel.com/i/jev-integrations), [guía](https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk), plantilla [vercel-labs/jev-ai-sdk-form-router](https://github.com/vercel-labs/jev-ai-sdk-form-router) que escala a `gpt-6-luna-fast` si hay incertidumbre.
- **OpenRouter:**
  - Modelo `typesafe/jev-1.13` ([yunusabd](https://news.ycombinator.com/item?id=49788874)), <400 ms según [Fabricio20](https://news.ycombinator.com/item?id=49786652).
  - `typesafe/jev-router`, un router "cache-aware" de modelo y esfuerzo ([X @OpenRouter](https://x.com/OpenRouter/status/2103610898690855161)).
  - Su cookbook de reembolsos: ≥0,9 se ejecuta, ≤0,1 se bloquea y lo intermedio va a un humano (citado por [jevtypesafeai.com](https://jevtypesafeai.com/use-cases/tool-risk-gate)).
- **Otros:**
  - Cloudflare Workers AI (`env.AI.run('typesafe/jev')`, [docs](https://developers.cloudflare.com/ai/models/typesafe/jev/)).
  - Proxies: Bifrost, MLflow gateway, GoModel ([verdverm](https://news.ycombinator.com/item?id=49850309)), LiteLLM y Opper ([opper.ai](https://opper.ai/blog/jev-vs-kev-open-decision-model)).

### 3.3 Frameworks, MCP y harnesses

- **Frameworks con integración.** Confirmadas por búsqueda de código; que exista el archivo no prueba que se use en producción.
  - LangChain, con `langchain-typesafe` y `TypeSafeClassifier`. El post del blog de LangChain ["Building a Harness with Jev"](https://www.langchain.com/blog/building-a-harness-with-jev) muestra middleware de model routing y `AutoModeMiddleware` para bloquear tool calls, y hubo un [webinar](https://events.langchain.com/webinar/building-a-harness-with-jev/).
  - Pydantic AI (`Agent("typesafe:jev-1.13.0")`, [docs](https://pydantic.dev/docs/ai/models/typesafe/)), LangChain4j, DSPy y TanStack AI `decide()`.
  - Microsoft Agent Framework, AutoGPT, Composio, AG2, AgentScope, Sentry, Opik, LanceDB (reranker), Airflow, Goose, deer-flow, gpt-researcher y DeepEval.
- **Servidores MCP:**
  - [jkudish/jev-mcp](https://github.com/jkudish/jev-mcp), con 12 tools: verify, screen, rerank, classify, gate…
  - [burnigtm/jev-mcp](https://github.com/burnigtm/jev-mcp), con política auto/review/escalate.
  - [PyModel/jev-judge-mcp](https://github.com/PyModel/jev-judge-mcp), [freepik-company/jev-mcp](https://github.com/freepik-company/jev-mcp), [itsmostafa/system-one-connector](https://github.com/itsmostafa/system-one-connector) (se registra en Claude Code, Codex, Hermes y Pi), [Brainwires/jevwire](https://github.com/Brainwires/jevwire), y el MCP de navegador de silbercue ([HN](https://news.ycombinator.com/item?id=49899408)).
  - Ojo: algunos clientes MCP descartan `TYPESAFE_API_KEY` sin avisar.
- **Harnesses de agentes de código:**
  - Claude Code: jevmem, fast-jev-compaction, jev-pruner, jev-belay (Stop hook que verifica afirmaciones de "terminado") y Winnow.
  - Codex: los routers de §1.2.
  - Pi: pi-jev-router, pi-jev-auto-mode, pi-warden y pi-system-one.
  - Kiro añadió Jev en preview para decidir turnos ([kiro.dev](https://kiro.dev/changelog/)).
  - La CLI `llm` de Simon Willison tiene el plugin `llm-typesafe` ([simonwillison.net](https://simonwillison.net/2026/Sep/21/jev/)).
- **Bases de datos:** Postgres (pg-jev, y redacción de PII en [pg-redact](https://pg-redact.vercel.app)), DuckDB (duckdb-jev), MySQL (mysql-ailike), MotherDuck (`prompt_jev()`), Neo4j (neo4jev) y Pandas/Polars ([jevframe](https://pypi.org/project/jevframe/)).

### 3.4 Clones open-source y APIs compatibles con `/v1/systemone`

- **Modelos entrenados:**
  - [jaredpalmer/kev](https://github.com/jaredpalmer/kev) (7,9k★): Qwen3.5/3.8 de 0,8B a 27B, y el SDK de TypeSafe funciona sin cambios. Al 5% de error, **Jev automatiza 0,70 de las decisiones contra 0,45–0,57 de Kev**.
  - [firelex/jeff](https://github.com/firelex/jeff) (564 puntos en HN): 0,8B/2B a ~22–30 ms en local. 83,1% en un panel donde Jev saca 83,0%, pero en BBH 64–68% frente a 94% de Jev.
  - [PostHog/jeeves](https://github.com/PostHog/jeeves): razona antes de decidir y supera a Jev en tests, pero con una mediana de ~3,3 s y un p90 de 17 s, lo que "defeats the point" ([itzikkatz](https://news.ycombinator.com/item?id=49896483)).
  - Laya (ModernBERT de 421M, 28k★), [wfzyx/von](https://github.com/wfzyx/von) (395M en CPU), CLM-8B de Stanford/Nvidia ([venturebeat](https://venturebeat.com/technology/stanford-and-nvidias-open-clm-8b-caches-reusable-agent-actions-and-runs-up-to-9x-faster-than-jev-in-tests)) y Rene-1 ([HF](https://huggingface.co/salfatigroup/rene-1-31b-fp8)).
- **Convertir un LLM en modelo de decisión:**
  - Por logits: [nokia/AnyJev](https://github.com/nokia-applied-research/AnyJev), [khimaros/verdict](https://github.com/khimaros/verdict) sobre llama-server, jeva.cpp, la PR de vLLM para DiffusionGemma, Privatemode con GLM-5.3-Flash ([blog](https://www.privatemode.ai/blog/system-one-from-glm-flash)) y [ikermoel/open-alternative-jev](https://github.com/ikermoel/open-alternative-jev).
  - Adaptadores de la interfaz: [zhulinchng/jevper](https://github.com/zhulinchng/jevper) y la función de un solo archivo de [allanrbo](http://allanrbo.blogspot.com/2026/09/a-jev-like-wrapper-for-llms-including.html).
  - Runtimes: [Ollaya](https://ollaya.dev/) ("Ollama para modelos de decisión", 613 puntos en HN).
- **Aviso de agent-chaperone:** con un LLM normal detrás de la interfaz de Jev, "those probabilities are not calibrated", y los umbrales pensados para Jev dejan de valer.

---

## 4. Tips y gotchas recurrentes

**Diseño de preguntas**
1. **Incluye siempre una opción "none of the above" o `no_link` y maneja esa rama en código.** Si falta la opción correcta, Jev elige otra con alta confianza ([segersniels](https://news.ycombinator.com/item?id=49841404), [suraj_phanindra](https://news.ycombinator.com/item?id=49803528), [screpy](https://screpy.com/blog/typesafe-jev-internal-linking-opportunities/)).
2. **Criterios concretos, con listas "not for" y un par de ejemplos.** Mejoran mucho los resultados ([segersniels](https://news.ycombinator.com/item?id=49828489)). Di **qué cuenta como evidencia suficiente**, no qué no es prueba ([Southbridge](https://www.southbridge.ai/blog/jev-entity-resolution)). Los criterios comparativos o vagos se quedan cerca de 0,5 ([Paper Radar](https://www.reddit.com/r/learnmachinelearning/comments/1wozkgj/)).
3. **Escribe las preguntas "como a un colega al otro lado del escritorio".** Tres calificadores "cuidadosos" empeoraron la calibración (ECE de 0,040 a 0,116) ([lindfors](https://lindfors.no/blog/a-first-look-at-typesafes-jev/)). Evita las dobles negaciones.
4. **Una dimensión por Score, y describe situaciones, no grados** ([bigglebear](https://news.ycombinator.com/item?id=49720601), [flaviocopes](https://flaviocopes.com/jev/)). Para medir algo en un espectro no uses Noul: en Noul 0,5 significa "no sé", no "a medias" ([dev.to/abyzgenic](https://dev.to/abyzgenic/typesafe-ai-jev-api-tutorial-choice-score-noul-and-the-gotchas-59gk)).
5. **Las keys de `questions` no llegan al modelo.** Todo el significado tiene que ir en `instructions`; usa backticks para apuntar a campos del state ([abyzgenic](https://dev.to/abyzgenic/typesafe-ai-jev-api-tutorial-choice-score-noul-and-the-gotchas-59gk)).
6. **Varias Nouls objetivas combinadas en código** (regresión logística, "todas deben pasar" o media geométrica) funcionan mejor que un Score directo de "urgencia" ([rahimnathwani](https://news.ycombinator.com/item?id=49839735), [jev-auto-approve](https://github.com/metalbear-co/jev-auto-approve)).
7. **Las preguntas de un mismo request no ven las respuestas de las otras.** Pide los juicios y deriva la acción en código ([devopsdaily](https://dev.to/devopsdaily/we-measured-the-200x-claim-and-got-it-wrong-twice-first-5ch5)).
8. **Choice y Noul tienen semánticas de probabilidad distintas.** Choice sobre eventos inciertos concentra la masa (dado: 0,83) y comprime un riesgo de 30% a 5%. Para probabilidades usa Noul, y no reutilices los umbrales de un tipo en el otro ([Hayashi](https://kantahayashiai.github.io/posts/jev-does-not-play-dice/), [Molas](https://www.alexmolas.com/2026/09/23/jev-cant-be-calibrated.html)).
9. **Choice con muchas etiquetas.** El máximo es 255, pero varios usuarios ven degradación por encima de ~20 ([EagnaIonat](https://news.ycombinator.com/item?id=49805115)). Una alternativa es encadenar Choices en jerarquía ([mercat](https://news.ycombinator.com/item?id=49721794), [r6i](https://blog.r6i.it/typesafe-jev-vs-agentic-loop.html)). No hay multi-label nativo: una Noul por etiqueta hace que las etiquetas vecinas se disparen juntas (issue #11 de sdk-js, según [notas de GitHub](https://github.com/typesafe-ai/typesafe-sdk-js)).

**State y costo**

10. **Fan-out: manda el state una vez y haz todas las preguntas.** La latencia apenas cambia: 1 pregunta tarda 0,37 s y 7 preguntas 0,36 s ([r6i](https://blog.r6i.it/typesafe-jev-vs-agentic-loop.html)). 13 preguntas en una llamada salieron 12x más baratas que 13 llamadas ([flaviocopes](https://flaviocopes.com/jev/)), y 25 preguntas costaron 3,6x lo de 5 ([Reddit](https://www.reddit.com/r/ClaudeAI/comments/1wm83ts/where_jev_can_take_work_off_claude_and_where_it/pb5bw1n/)). Comparar candidatos juntos rinde más que por separado ([Unblocked](https://getunblocked.com/blog/jev-in-production-vs-cross-encoder/)).
11. **Cada request lleva ~257–260 tokens fijos de overhead.** En textos cortos el costo relativo se multiplica hasta 12x ([Opper](https://opper.ai/blog/jev-vs-kev-open-decision-model), [emschwartz](https://emschwartz.me/please-add-prompt-caching-to-jev-style-models/)). No hay prompt caching: las preguntas se cobran cada vez ([zenlikethat](https://news.ycombinator.com/item?id=49720701) [STAFF]).
12. **Límites de contexto:**
    - Varios reportan que corta en ~30–32k tokens ([treg.to/jev](https://treg.to/jev), [mercat](https://news.ycombinator.com/item?id=49722044)). Otros citan 64k en total y 32k para state más pregunta ([burnigtm](https://github.com/burnigtm/jev-mcp), [Unblocked](https://getunblocked.com/blog/jev-in-production-vs-cross-encoder/)).
    - **La precisión cae con contenido irrelevante:** filtra el state.
    - Meter varios registros por request degrada la calidad: Kasra usa máximo 5 ([kasra.blog](https://kasra.blog/blog/classification-and-jev/)) y emschwartz, uno.
    - Recortar demasiado también falla: con solo los primeros 25 links de la página, la precisión fue 0/8 ([shaharia](https://shaharia.com/blog/jev-cli-browser-automation-speed-benchmark/)).
13. **El tokenizador gasta 2–3 tokens por palabra**, así que el ahorro real frente a Haiku ronda 10x y no 20–25x ([Reddit](https://www.reddit.com/r/ClaudeAI/comments/1wm83ts/where_jev_can_take_work_off_claude_and_where_it/pb5bw1n/)).

**Umbrales, calibración y operación**

14. **"Tune the threshold, not the prompt."** Nueve variantes de prompt no movieron nada ([Unblocked](https://getunblocked.com/blog/jev-in-production-vs-cross-encoder/)). No uses 0,8 porque lo dice un README: calibra con ejemplos propios ([Selmar](https://github.com/Selmar/typesafe-jev-calibrate-for-code-review)). El ruido es mayor justo cerca del umbral (stdev 0,037 a 0,587 frente a 0 en 0,98).
15. **Compuertas asimétricas con abstención.** Actúa solo con alta confianza y escala el resto a un LLM o a un humano, con una zona muerta en medio (≥0,6 sí, ≤0,4 no) ([GitLoom](https://gitloom.ai/blog/jev-in-production), [Vega](https://labs.vega.io/blog/bubble-sheets-for-secops/), [vercel-labs](https://github.com/vercel-labs/jev-ai-sdk-form-router), [Reddit](https://www.reddit.com/r/learnmachinelearning/comments/1wm8yt5/)). Patrón "cheap-confirm-escalate" ([sroussey](https://news.ycombinator.com/item?id=49763623)).
16. **Recalibra con tus datos** (Platt, isotónica o conformal) y mide con NLL, Brier o ECE ([olooney](https://news.ycombinator.com/item?id=49824215), [apwheele](https://news.ycombinator.com/item?id=49819197), [foxladmin](https://news.ycombinator.com/item?id=49879036)). Usa la probabilidad máxima en lugar de `confidence`.
17. **Empieza en modo *shadow*** junto al LLM actual y ajusta los umbrales con tu propio log ([Polylane vía vitran_orca](https://news.ycombinator.com/item?id=49882532), agent-chaperone, pi-jev-router, jevals).
18. **Fija la versión (`jev-1.13.0`) y registra `response.model`,** porque `jev-latest` se mueve y puede desplazar los umbrales ([flaviocopes](https://flaviocopes.com/jev/), docs de Pydantic AI).
19. **Cachea las decisiones:** cada decisión es casi una función pura de (modelo, schema, state) ([jevcache](https://jevcache.sh/)). Guarda los inputs y outputs para entrenar tu propio modelo más adelante; Jev como "gateway drug" ([senko](https://news.ycombinator.com/item?id=49891793), [Jevstiller](https://jevstiller.pages.dev/posts/the-guarantee/)).
20. **Evalúa bien:**
    - Imprime el baseline de clase mayoritaria ("the 79% constant trap", [Archestra](https://archestra.ai/blog/we-tested-jev-on-100-real-agent-calls)).
    - No evalúes con etiquetas que generó el sistema incumbente ([Unblocked](https://getunblocked.com/blog/jev-in-production-vs-cross-encoder/)).
    - Separa los datos por familia y no al azar: al azar da 98%, por familia 90% ([dev.to/ikkun1222](https://dev.to/ikkun1222/jev-one-judgment-call-or-twelve-dimension-scores-i-measured-both-on-three-classification-tasks-31fd)).
    - Recuerda que un checker roto también da PASS con total confianza ([Reddit](https://www.reddit.com/r/ClaudeAI/comments/1wps3ci/)).

**Lo que no hay que pedirle**

21. **Aritmética, conteo, fechas, hex/RGB, multi-hop, planificación y generación de texto.** Precalcula en código (pot odds, SPF/DKIM, comparación de fechas) y usa un LLM para escribir. Lee antes la página de "jaggedness" de la doc ([backnotprop](https://backnotprop.com/blog/jev-poker/), [albertcas](https://github.com/albertcas/jev-mail-filtering), [Reddit](https://www.reddit.com/r/ClaudeAI/comments/1wm83ts/)). "Code controls the flow; the model only answers bounded questions."
22. **Construir el estado es el trabajo real:** historial de sesión en el ruteo ([Weave](https://weaveos.com/blog/why-you-shouldnt-use-jev-for-coding-agents-and-routing)), contexto del tenant en SecOps ([Vega](https://labs.vega.io/blog/bubble-sheets-for-secops/)) y hechos del analizador en code review ([Selmar](https://github.com/Selmar/typesafe-jev-calibrate-for-code-review)).
23. **Es solo texto y JSON:** no es multimodal "for now" [STAFF] ([item](https://news.ycombinator.com/item?id=49718414)). Según la doc "excels in English", aunque hay buenos resultados en noruego ([lindfors](https://lindfors.no/blog/a-first-look-at-typesafes-jev/)).

**Bugs y problemas de forma reportados**

24. Un criterio `{"options":[...]}` en Choice **se acepta en silencio** como una sola opción y responde siempre con confianza 1,0: "We shipped that bug" ([jev-cookbook](https://github.com/chr-kelly/jev-cookbook)).
25. En un casi empate, la `choice` devuelta puede quedar 0,01 por debajo de otra opción (issue #15 de sdk-python).
26. Cloudflare devuelve un HTML 403 si el state contiene un `curl` con URL (issue #15 de sdk-js). NaN e Infinity se serializan como null sin avisar.
27. Errores 429 y 529: reintentar con backoff. Los rate limits citados son 250k tokens/s y 1.200 req/min ([flaviocopes](https://flaviocopes.com/jev/)). Hubo cuelgues del gateway en picos de demanda ([jevals](https://github.com/openlayer-ai/jevals)).

---

## 5. Ideas creativas o inusuales

- **Generar texto letra a letra con Choice:**
  - Chatbot [jevchat](https://github.com/kyle-pena-nlp/jevchat): "the results are hilarious".
  - [Jev-Leftpad](https://github.com/f/jev-leftpad), una parodia con `space_0..space_10`.
  - [is-odd-jev](https://github.com/alxcrt/is-odd-jev), que dice si un número es impar "con probabilidad calibrada".
  - Un "LLM" armado con 521 modelos Jev ([jevs.chat](https://jevs.chat/)) y un chatbot que solo responde con emojis ([jev.chat](https://jev.chat)).
- **Lenguajes de programación:**
  - [Jevlang](https://github.com/RoyWiggins/jevlang) delega cada condición de `if`/`while` a Jev, y fuzzyif hace `if fuzzy("¿Es urgente?", msg)`. Con fuzzyif se reemplazaron 418 líneas de if/elif de Ansible ([dev.to/tdual](https://dev.to/tdual/i-let-an-llm-judge-inside-pythons-if-statements-then-ran-ansibles-own-tests-on-it-43fo)).
  - ["Probably"](https://probably-lang.southpolesteve.workers.dev/) es un lenguaje para workflows con LLM.
  - Una propuesta combina design-by-contract con Jev ([futurisold](https://news.ycombinator.com/item?id=49719442)).
- **Compiladores y sistemas:**
  - [jevopt](https://github.com/Ramneet-Singh/jevopt) toma decisiones de optimización del compilador.
  - [jevmetrics](https://github.com/ishantanu/jevmetrics) reduce métricas dentro de OpenTelemetry.
  - [jevq](https://github.com/who/jevq) funciona como sidecar de jq.
  - [Grev](https://github.com/aurorainfra/grev) es un "grep que piensa": 250 MB de logs por ~$10 ([devttyeu](https://news.ycombinator.com/item?id=49850673)).
- **Juegos y simulación:**
  - Doom, Pokémon Red, en vivo ([jev-pokemon](https://jev-pokemon.vercel.app/)) y en FireRed leyendo la RAM de la GBA ([JevEmon](https://github.com/daniel4x/JevEmon)).
  - Minecraft ([Herobrine](https://github.com/xatuke/herobrine)), StarCraft II ([JEV-Star](https://github.com/sc2musa/Jev_Star)) y NPCs tácticos en un shooter ([coffee.yardsort.sh](https://coffee.yardsort.sh/)).
  - Niveles generados en tiempo real ([spritefusion](https://www.spritefusion.com/blog/generating-game-level-in-real-time-with-jev)), una colonia de ratones ([jev-mice](https://mice.jev.carsonsweet.com/)) y "civilizaciones" ([jev_civilization](https://github.com/JonesSteven/jev_civilization)).
  - Pokémon Showdown contra Opus 5: Jev ganó por $0,0029 frente a $2,35 ([X](https://x.com/sid19arya0/status/2100458351440048258)).
- **Juegos sociales y novedades:**
  - "Convence a Jev de tu inocencia" ([judge-jev.com](https://judge-jev.com/)), el dilema del tranvía ([gpu.studio/trolley](https://gpu.studio/trolley)) y pitchearle tu startup ([pitchjev](https://pitchjev.vercel.app/)).
  - Bola 8 mágica ([jevball](https://jevball.rorz.io/)), CAPTCHA reconstruido con Jev ([localcan](https://www.localcan.com/blog/build-your-own-captcha)) y una red social moderada por Jev ([jevdit](https://jevdit.com)).
  - Jev predice tus decisiones de vida ([quiz.seek.ws](https://quiz.seek.ws/)) y adivina lo que dibujas sin ver ([mikulskibartosz](https://mikulskibartosz.name/typesafe-jev-guess-what-i-drew)).
- **Robótica y mundo físico:**
  - Un enjambre de 15 drones simulados ([jev-reflex-autonomy-lab](https://github.com/khordoo/jev-reflex-autonomy-lab/tree/main)) y una flota robótica simulada a $24,57 por millón de decisiones ([jev-physical-ai](https://github.com/robokrunch/jev-physical-ai)).
  - Brazo que "sustituye la cinemática inversa" ([X](https://x.com/CaloriePaper/status/2102049098123944349)).
  - Demo viral de "FSD de Tesla en una hora" ([X](https://x.com/jpschroeder/status/2100347770867458384)), **sin datos**.
  - Pronóstico del tiempo ([ninetysky](https://ninetysky.com/research)).
- **Interfaces:**
  - Escribir sin espacios o autocorrección avanzada ([levmiseri.com/nospace](https://levmiseri.com/nospace/)) y un teclado swipe ([viccis](https://news.ycombinator.com/item?id=49803291)).
  - Puertas automáticas "estilo Star Trek" que infieren intención ([TeMPOraL](https://news.ycombinator.com/item?id=49854314)).
  - UI generativa, donde "Jev elige la UI y TypeScript hace la matemática" ([ShapeshiftUI](https://anishfn.qala.lol/writing/shapeshift)).
  - "Reverse Jev": terminar el turno de Claude Code con una elección en lugar de prosa ([kvit](https://blog.kvit.app/posts/ending-a-turn-with-a-choice/)).
- **Filtros personales:**
  - Extensiones que limpian el "slop" de X y LinkedIn ([slopmop](https://slopmop.lol), [slop-filter](https://github.com/adamnroman/slop-filter)).
  - Un feed de HN a tu gusto ([hn-for-me](https://github.com/raahelpie/hn-for-me)) y un filtro de discusiones largas de HN ([hazumi](https://www.hazumi.news/best)).
  - Una extensión que decide si una página "vale la pena" ([rot-guard](https://github.com/plusminushalf/rot-guard)).
- **Roleplay y voz:**
  - "Sensores" de deriva narrativa para SillyTavern: un Score 0–4 con alerta si la media baja de 2 ([Reddit](https://www.reddit.com/r/SillyTavernAI/comments/1wl7uje/)).
  - Una head que decide "¿me están hablando a mí?" antes de generar la respuesta ([Reddit](https://www.reddit.com/r/LocalLLaMA/comments/1wslcum/)).
  - Detección de estafas telefónicas en tiempo real con ElevenLabs, ~180 ms ([jevable.com](https://jevable.com/)).
- **Ciencia y datos:**
  - Radar de todo arXiv y señales Kepler de la NASA: 72,5% frente a 64,4% de las reglas ([Reddit](https://www.reddit.com/r/learnmachinelearning/comments/1wlps7k/)).
  - Explorar un espacio semántico 2D ([semanticspace.dev](https://semanticspace.dev/)).
- **Delegación inversa.** Un LLM fija las metas y Jev ejecuta los movimientos; si baja la confianza, Jev devuelve el control. Otra variante escala Jev → Sonnet → Opus → Fable según la dificultad ([jackbrookes](https://news.ycombinator.com/item?id=49855780), [staindk](https://news.ycombinator.com/item?id=49849494)).
- **Usar Jev como maestro y no como modelo de producción:**
  - Como "teacher" de un modelo pequeño que escribe historias ([trulm](https://blog.trulm.com/posts/tiny-story-writer-with-a-teacher/)).
  - Destilarlo a un modelo local con una cota de desacuerdo ([Jevstiller](https://jevstiller.pages.dev/posts/the-guarantee/)).
  - Explicar un Score preguntando Nouls sobre 30 razones que generó Codex ([ralusek](https://news.ycombinator.com/item?id=49778740)).

---

*Investigación hecha con búsquedas en HN (API de Algolia), feeds RSS de Reddit, `gh search` y fetch de blogs. Casi todas las cifras las reporta su propio autor sobre muestras pequeñas.*
