# 4. Patrones de arquitectura y cookbooks oficiales

> Fuentes: `/patterns/*`, `/cookbooks/*` y `/demos/*` de <https://docs.typesafe.ai>. Los cookbooks se corrieron sobre `jev-1.12` o `jev-1.13.0`, con fechas entre jul y sep de 2026. Las cifras son de TypeSafe.

## 4.1 Los patrones oficiales

| Patrón | Qué hace | Beneficio |
|---|---|---|
| **Speculative fan-out** | Mandar todas las preguntas que *podrías* necesitar en una sola llamada. El código ignora las que no aplican | Costo y velocidad. El state se paga una vez: 12.2× más barato y 10× más rápido en el cookbook de GDPR |
| **Confidence-gated routing** | Usar `confidence` como segundo eje: la respuesta dice *qué* y la confianza dice *si actuar*. Los umbrales escalan con el costo del error | Confiabilidad y seguridad |
| **Composite scoring** | Partir un juicio difuso en Scores atómicos, normalizarlos (`score / (niveles−1)`) y ponderarlos en código | Transparencia: cambias pesos, no prompts. Sirve para distintos perfiles con las mismas respuestas |
| **Intent routing** | Clasificar la intención (Choice) y la complejidad (Score). Según el resultado, se manda a código determinista, a un LLM especialista o a un humano | Costo: el LLM caro solo ve lo que lo necesita |

Hay dos patrones más que describen blogs comunitarios, como el de DEV Community, y que coinciden con los cookbooks:

- **Cascade:** Jev rutea o verifica. El código resuelve lo que puede y un modelo de frontera toma la minoría difícil (ver *SDE cascade*).
- **Retrieve then judge:** primero filtrar o recuperar con precisión y después juzgar, para evitar el context rot (ver *Classifying RAG passages*).

### Ejemplo: intent routing

```python
intent, complexity = r.answers["intent"], r.answers["complexity"]
if intent.confidence < 0.5:
    return route_to_human_agent(ticket)
if intent.choice == "order_status":
    handle_order_status(ticket)                      # código, sin LLM
elif intent.choice == "product_question":
    handle_with_llm(ticket, PRODUCT_SPECIALIST)
elif intent.choice == "return_exchange":
    handle_with_llm(ticket, RETURNS_SPECIALIST)
elif intent.choice == "complaint":
    if complexity.score > 1 or complexity.confidence < 0.5:
        route_to_human_agent(ticket)
    else:
        handle_with_llm(ticket, COMPLAINT_RESOLUTION)
```

### Ejemplo: composite scoring (screening de CVs)

```python
py   = r.answers["python_depth"].score / 4        # Scores de 5 niveles, normalizados a 0..1
lead = r.answers["team_leadership"].score / 4
arch = r.answers["system_design"].score / 4
gen  = r.answers["generalist"].score / 4
ic_score = 0.40*py + 0.10*lead + 0.40*arch + 0.10*gen   # Senior IC
em_score = 0.15*py + 0.40*lead + 0.20*arch + 0.25*gen   # Engineering Manager
```

## 4.2 Trucos que se repiten en los cookbooks

| Truco | Dónde aparece |
|---|---|
| **Las opciones de un Choice son los candidatos**, ya sean spans de regex, ids de línea, ids de skill o hijos de un nodo. El modelo apunta y el código es dueño del string | Pre-parsed extraction, Line-by-line search, Skill suggestion, Hierarchical |
| **Choice (relativo) + Noul (absoluto):** el Choice dice *cuál* y el Noul dice *si alguna* aplica. Las probabilidades de un Choice siempre suman 1, así que siempre hay un ganador aunque ninguno sirva | Line-by-line search (`where` + `exists`), Skill suggestion (`which` + `fits`) |
| **Escotilla `none` / `other` / `not stated`** en los Choices | Extraction, Date extraction |
| **Banda de incertidumbre** en lugar de un solo corte en 0.5 (p. ej. 0.30–0.70, que va a humano) | Self-consistency, Guardrails |
| **Agregación por mínimo:** la confianza del resultado es la de la parte más débil | Date extraction, Function calling |
| **Agregación por máximo:** se escala si *cualquier* señal se dispara | SDE cascade |
| **Score con nivel intermedio con significado** (p. ej. "a curador") y redondeo al nivel más cercano. No hay umbrales que ajustar | Entity alignment |
| **"Malo = TRUE"** en los verificadores, preguntas estrechas por campo | SDE cascade |
| **Re-rutear sin volver a llamar:** guarda las probabilidades y cambia la política en código | RAG passages, Guardrails |
| **Beam search sobre probabilidades de Choice** para taxonomías profundas | Hierarchical classification |
| **Jev como feature extractor** para un modelo clásico (CatBoost) | Autoresearch |

Límites que citan los cookbooks:

- Choice: máximo 255 opciones. Uno de los cookbooks dice que "funciona de forma fiable hasta ~240".
- Score: máximo 10 niveles. Con 11 el servidor devuelve error.

---

## 4.3 Resumen de cada cookbook


### 1. Structure recovery (`cookbooks_autoformat.md`)

**Problema.** Reconstruir Markdown (headings, párrafos, listas, quotes, code, callouts) a partir de texto plano que perdió el formato (líneas cortadas a mitad de frase, sin `#` ni viñetas). Caso: un memo de migración de build system. El modelo nunca genera texto: sólo responde preguntas acotadas y el código renderiza, así cada carácter de salida viene del input.

**Diseño de preguntas / state.**
- El state es el documento con cada línea etiquetada con un id (`L014| ...`); los blank lines se conservan como separadores. Tras el pass 1, los bloques se re-etiquetan `B000| ...`.
- **Pass 1 (stitch):** una `Noul` por par de líneas adyacentes (se omiten pares separados por línea en blanco): "¿La línea Lxxx retoma a mitad de frase?". 16 preguntas en una request.
- **Pass 2 (classify):** por bloque, un `Choice` de tipo (heading/paragraph/list_item/quote/code/callout) + preguntas "compañeras" hechas por adelantado: `hlevel` (Choice title/section/subsection, sólo si el bloque ≤ 90 chars), `step` (Noul: ¿el orden importa?) y `callout` (Choice note/tip/warning). 62 preguntas sobre 17 bloques, una request.
- Evidencia directa (líneas en blanco, marcadores `- `, `1.`, `#`) se resuelve en código, no se manda al modelo.

**Truco clave.**
- Preguntas compañeras especulativas: se preguntan todas en la misma request y sólo se leen si el tipo lo amerita (evita un tercer round trip; el state es la mayor parte de los tokens y se manda una vez).
- La redacción importa: "¿retoma a mitad de frase?" vs. el ingenuo "¿son del mismo párrafo?". Con la ingenua, los ítems de lista puntuaban >0.75 y se colapsaban (17 bloques vs. 12). "Cuando un juicio alimenta un umbral, la pregunta debe nombrar el hecho más estrecho que lo decide."
- Toda la especificación del clasificador vive en tres dicts de criterios de una línea.

**Umbrales / confianza.**
- Merge: `JOIN_AFTER_DANGLING = 0.2` (línea anterior sin puntuación final) y `JOIN_AFTER_TERMINAL = 0.5` (tras `. ! ? : ;`). Continuaciones reales puntuaron desde 0.39; el primer ítem de lista tras ":" puntuó 0.22, por eso el umbral depende de la puntuación que lee el código.
- Lista numerada si la media de `step` de los ítems ≥ 0.5 (`STEP_THRESHOLD`), decisión a nivel grupo.
- Sugerencia: marcar para revisión cualquier bloque con confidence de tipo < 0.55. El bloque menos seguro: confidence 0.43 (paragraph 0.53, list_item 0.24, callout 0.19).

**Resultados.** 28 líneas → 17 bloques (11 saltos sanados). Pass 1: 16 preguntas, 0.32 s; pass 2: 62 preguntas, 0.51 s. Total 10,211 tokens, 0.8 s. (El texto dice \$0.0015; la salida impresa del appendix muestra \$0.0003.) Modelo `jev-1.12`, precio (0.042, 0.00) \$/1M tokens. Ítems de pasos con step ≈ 0.86–0.90 (numerados); equipos ≈ 0.12–0.16 (viñetas).

```python
JOIN_AFTER_DANGLING, JOIN_AFTER_TERMINAL = 0.2, 0.5

def join_question(i: int) -> Noul:
    return Noul(
        instructions=f"Does line {line_id(i)} pick up mid-sentence, continuing a sentence left unfinished at the end of line {line_id(i - 1)}?",
        criteria=NoulCriteria(
            true="The line starts in the middle of a sentence that began on the previous line - the line break tore the sentence apart",
            false="The line begins a new sentence, item, heading, or thought of its own",
        ),
    )

def merge(joins: list[float]) -> list[dict]:
    blocks = []
    for i, line in enumerate(LINES):
        bar = (
            JOIN_AFTER_TERMINAL
            if i and ends_terminal(LINES[i - 1]["text"])
            else JOIN_AFTER_DANGLING
        )
        if blocks and not line["gap"] and joins[i] >= bar:
            blocks[-1]["text"] += " " + line["text"]
            blocks[-1]["lines"].append(i)
        else:
            blocks.append({"text": line["text"], "lines": [i], "gap": line["gap"]})
    return blocks
```

---

### 2. Autoresearch feature discovery (`cookbooks_autoresearch_feature_discovery.md`)

**Problema.** Convertir texto libre (notas de cata de vino) en columnas numéricas para un regresor supervisado (CatBoost) que predice la puntuación del crítico (80–100), sin escribir las preguntas a mano: un LLM (`claude-sonnet-5`) propone preguntas, TypeSafe las responde por fila, CatBoost entrena, y los errores del modelo alimentan la siguiente propuesta (loop "autoresearch"). Datos: 2,000 reseñas de WineMag (1,200 dev / 800 held-out que el loop nunca ve).

**Diseño de preguntas / state.**
- State = la nota de cata completa (una request por nota, con todas las preguntas de la ronda).
- Dos tipos: **`intensity` → `Score`** con una rúbrica fija de 5 niveles ("Not present…" → "Dominant…") y **`presence` → `Noul`** (true: "The note states this or clearly implies it").
- Codificación: un Score da 2 columnas (media esperada del nivel + desviación, modo `mean_spread`); un Noul da 1 columna (probabilidad). Final: 38 preguntas (29 Score + 9 Noul) = 67 columnas.
- El proponedor devuelve hasta 18 acciones por ronda (`add` / `revise` / `drop`) con JSON schema estructurado.

**Truco clave.**
- No se filtra ninguna pregunta antes de responderla: todas las de la ronda van en la misma request, así una pregunta extra no cuesta request extra.
- El feedback al proponedor: los 30 peores + 30 mejores notas dev (predicción actual y anterior), importancia % por feature y su spread.
- Revisiones y drops se prueban con refit (sin llamadas API) y sólo se aceptan si baja el error CV dev.
- `PROPOSER_TASK` es el único string que sabe de vino: se reapunta a cualquier dato etiquetado.

**Umbrales / confianza.** `MIN_SPREAD = 0.05` (columna demasiado plana se descarta), `CHANGE_TOLERANCE = 0.0` (revisión/drop debe mejorar, no sólo no empeorar). 5-fold × 3 repeticiones. Límite práctico: `Score` admite máx. 10 niveles (11 da error de servidor).

**Resultados (800 held-out).**

| Brazo | RMSE | Spearman |
|---|---|---|
| Predecir la media | 3.088 | -0.014 |
| CatBoost con word counts | 2.466 | 0.605 |
| Pedir el score directo a TypeSafe (Score 10 bandas, shift -1.71) | 2.145 | 0.761 |
| 18 preguntas de la ronda 1, sin loop | 1.869 | 0.778 |
| **38 preguntas tras 5 rondas** | **1.772** | **0.799** |

Ronda 1 → 5: -0.097 puntos, IC95% [-0.147, -0.050]. La mayor parte de la ganancia viene de la primera propuesta. Feature más importante: `note_overall_tone_positivity` (17.4%). En la ronda 5 el loop ya proponía más drops (8) que adds (4) y el dev dejó de mejorar. Coste en requests: una por fila por ronda (2,000 por ronda); 8 workers ya puede topar el rate limit de una key compartida. Modelos: `jev-1.12` y `claude-sonnet-5` (2026-08-03).

```python
def feature_questions(features: list[dict]) -> dict:
    questions = {}
    for feature in features:
        if feature["kind"] == "intensity":
            questions[feature["name"]] = Score(
                instructions=feature["question"], criteria=INTENSITY_LEVELS
            )
        else:
            questions[feature["name"]] = Noul(
                instructions=feature["question"], criteria=PRESENCE_CRITERIA
            )
    return questions

def encode(feature: dict, probabilities: np.ndarray, mode: str) -> list[tuple]:
    name = feature["name"]
    if feature["kind"] == "presence":
        return [(name, probabilities[:, 0])]  # one number is all there is
    levels = np.arange(probabilities.shape[1])
    mean = probabilities @ levels
    if mode == "mean_spread":
        variance = probabilities @ (levels**2) - mean**2
        return [(name, mean), (f"{name}_sd", np.sqrt(np.clip(variance, 0, None)))]
```

---

### 3. Double-checking citations (`cookbooks_citation_check.md`)

**Problema.** Detectar citas erróneas o alucinadas que un LLM adjunta a sus afirmaciones (claim + sección + quote) contra el documento fuente. Caso: 8 citas sobre RFC 7519 (JWT); 4 correctas y 4 manipuladas para fallar.

**Diseño de preguntas / state.**
- Paso 1 (sin modelo): string match normalizado (espacios y comillas curvas). Si el quote no está en la fuente → `fabricated` directamente. Si la cita no trae quote, se usa la sección que nombra ("section-only").
- Paso 2: **un solo `Choice`** por cita superviviente, con state estructurado `{"claim": ..., "section": ...}` (la sección donde se encontró el quote = su contexto). Opciones: `supports` / `contradicts` / `says_nothing` → mapeadas a `verified` / `contradicted` / `unsupported`.

**Truco clave.** Lo que se puede decidir en código (existencia literal del quote) no se manda al modelo; el modelo sólo juzga si el contexto respalda la afirmación. Un quote puede ser literal y aun así el claim ser falso (`exp_required`: la misma sección dice "Use of this claim is OPTIONAL").

**Umbrales / confianza.** `AUTO_ACCEPT = 0.8`: confidence ≥ 0.8 → el veredicto se aplica solo; < 0.8 → lo confirma un humano. "Empieza alto y baja el umbral conforme ganes confianza en el modelo." Para `fabricated` la confidence es `None` (no hubo llamada).

**Resultados.** Las 4 correctas → `verified` con confidence ≥ 0.93 (0.93, 0.95, 0.99, 0.99). Las 4 fallas detectadas: 1 `fabricated` (string match), 1 `contradicted` (0.99), 2 `unsupported` a revisión (0.27 y 0.56). Limitación: el match es exacto tras normalizar; quotes truncados o reescritos salen como `fabricated` (en producción haría falta fuzzy matching). `jev-1.12`, 2026-08-16.

```python
QUESTIONS = {
    "relation": Choice(
        instructions="How does the section relate to the claim?",
        criteria={
            "supports": "The section states the claim or directly implies that it is true",
            "contradicts": "The section states the opposite of the claim or implies it is false",
            "says_nothing": "The section does not address what the claim asserts, either way",
        },
    ),
}

def verdict(status: str, answer: dict | None) -> dict:
    if status == "missing":
        return {"verdict": "fabricated", "confidence": None, "auto": True}
    return {
        "verdict": RELATION_TO_VERDICT[answer["choice"]],
        "confidence": answer["confidence"],
        "auto": answer["confidence"] >= AUTO_ACCEPT,
    }
```

---

### 4. Classification using confidence (`cookbooks_classification_using_confidence.md`)

**Problema.** Clasificar la sección "Item 1 Business" de reportes 10-K de la SEC en los 75 major groups de SIC, y decidir sin llamadas extra cuándo confiar en la etiqueta fina. 60 filings (1993–2024, 700–2,200 palabras; filtrados para que el texto respalde el código que el filer eligió).

**Diseño de preguntas / state.**
- State = el texto del Item 1 del filing.
- **Un único `Choice` con 75 opciones** (los grupos SIC). Cada opción se describe por las industrias que contiene (umbrella title + hasta `MAX_NAMED = 8` industrias), porque muchos grupos no traen nombre propio.
- La jerarquía (grupo → 10 divisiones) se construye en código a partir del TSV de la SEC, sin modelo.

**Truco clave.** Leer `confidence` (qué tan concentrada está la distribución) en vez de la probabilidad del ganador: 0.45 vs. runner-up 0.44 no es lo mismo que 0.45 con el resto disperso. Si la confianza es baja, se reporta la **división padre** del grupo elegido: la etiqueta amplia se deriva de la estrecha, sin segunda llamada. Un Choice funciona de forma fiable hasta ~240 opciones.

**Umbrales / confianza.** `CONFIDENT = 0.9`: ≥ 0.9 → grupo; < 0.9 → división. Ese corte parte los 60 filings a la mitad. Los casos de baja confianza (0.22–0.29) eran empresas en etapa de desarrollo o con un segmento recién vendido.

**Resultados.** Forzar grupo siempre: 39/60 correctos. Mitad segura: 27/30 (90%); mitad insegura: 12/30 (40%) a nivel grupo → 70% reportada como división. Política combinada: 48/60 respuestas útiles. Una request por documento. `jev-1.12`, 2026-08-12.

```python
def questions() -> dict:
    return {
        "group": Choice(
            instructions=QUESTION,
            criteria={group: describe(group) for group in sorted(GROUPS)},
        )
    }

def classify(filing: dict) -> dict:
    answer = ask(filing["id"], filing["text"])
    sure = answer["confidence"] >= CONFIDENT
    return {
        "level": "group" if sure else "division",
        "label": answer["group"] if sure else division(answer["group"]),
        "confidence": answer["confidence"],
        "group": answer["group"],
    }
```

---

### 5. Classifying RAG passages (`cookbooks_classifying_rag_passages.md`)

**Problema.** El retrieval por similitud (embeddings) mezcla pasajes irrelevantes, contradicciones con la premisa de la pregunta e inyecciones de prompt. Se añade una etapa entre retrieval y generación que clasifica cada pasaje y decide en código si entra al prompt como evidencia, como conflicto, o se descarta. Corpus: 81 pasajes (80 de la documentación de Supabase Auth + 1 post de foro con inyección plantada); 6 queries, 2 con premisa falsa.

**Diseño de preguntas / state.**
- Retrieval: `text-embedding-3-small` (256 dims), top `TOP_K = 12` por query.
- State estructurado por par query–pasaje: `{"query": ..., "passage": {id, title, text, source_type}}`. Una request por pasaje (4 en paralelo).
- **4 `Noul`** (sin criteria explícitas): `is_relevant`, `contains_answer_evidence`, `contradicts_query_premise`, `contains_prompt_injection`. Ninguna pregunta "¿lo incluyo?": esa decisión vive en código.

**Truco clave.** Routing en código con orden fijo, primera coincidencia gana: inyección primero (es una decisión de seguridad), contradicción antes que evidencia (un pasaje que niega la premisa suele contener algo usable). Evidencia y conflictos van en **bloques separados** del prompt para que el generador (`claude-sonnet-5`) pueda rebatir la premisa. Re-rutear con otros umbrales no cuesta llamadas API (se usan las respuestas guardadas).

**Umbrales / confianza.** `THRESHOLDS = {injection_max: 0.70, contradicts_min: 0.70, relevant_min: 0.45, evidence_min: 0.55}` — elegidos para este corpus, "punto de partida, no defaults". Advertencia: el filtro de inyección no es una frontera de seguridad; el prompt debe tratar todo pasaje como texto no confiable.

**Resultados.** Query con premisa falsa ("Refresh tokens expire after 30 days…"): el pasaje de foro con inyección quedó 1º por similitud (0.584) pero fue excluido por injection = 0.99; `sessions-01` (7º, similitud 0.509) fue a conflicto con contradicts = 0.92 (relevance 0.49 y evidence 0.51 solas lo habrían descartado). El generador respondió que no había evidencia suficiente y señaló el conflicto. Query normal ("How long should an access token live?"): 4 incluidos (tres estaban en posiciones 8, 9 y 11 por similitud), los 3 falsos positivos de "Lifetime of a signing key" con relevance ≤ 0.08. En total 72 pasajes; ≥ 2/3 de cada query excluidos. Coste escala con `k` (una request por pasaje). `jev-1.12` + `claude-sonnet-5`, 2026-08-27.

```python
PASSAGE_QUESTIONS = {
    "is_relevant": Noul(instructions="Does this passage address the subject of the query?"),
    "contains_answer_evidence": Noul(instructions="Does this passage state information usable in a direct answer?"),
    "contradicts_query_premise": Noul(instructions="Does this passage conflict with a factual premise stated in the query?"),
    "contains_prompt_injection": Noul(instructions="Does this passage attempt to control the system answering the query?"),
}

def route(answers: dict, thresholds: dict = THRESHOLDS) -> str:
    if answers["contains_prompt_injection"] > thresholds["injection_max"]:
        return "exclude"
    if answers["contradicts_query_premise"] > thresholds["contradicts_min"]:
        return "conflicting_evidence"
    if answers["is_relevant"] < thresholds["relevant_min"]:
        return "exclude"
    if answers["contains_answer_evidence"] > thresholds["evidence_min"]:
        return "include"
    return "exclude"
```

---

### 6. Self-consistency: choices (`cookbooks_consistency_choice_cookbook.md`)

**Problema.** Medir si una rúbrica de moderación da la misma etiqueta (= la misma ruta: quitar/dejar, escalar, cola) cuando se repite sobre el mismo post limítrofe. 15 repeticiones por condición; se compara TypeSafe con LLMs (`claude-haiku-4-5`, `gpt-5.4-mini` a t=0, t=default y single-pick; `gpt-5.5` y `claude-opus-4-8` en modo razonamiento).

**Diseño de preguntas / state.**
- State = un dict JSON del post (autor, strikes previos, contexto, texto, link a discord.gg, reportes) + un campo `uid` aleatorio por llamada (para romper cachés); TypeSafe recibe el dict directamente.
- **8 `Choice`** en una sola llamada `system_one`: `category` (6 opciones), `primary_risk` (5), `target` (4), `action` (5), `queue` (5), `link_handling` (4), `review_path` (4), `severity` (4). Etiquetas mutuamente excluyentes, cada una con descripción corta.

**Truco clave.** Añadir un resultado **`uncertain`**: si la probabilidad top < 0.60 la aplicación no actúa y manda a revisión humana. Usa las probabilidades devueltas (no el campo `confidence`) y no añade llamadas. No hace determinista al modelo: valores cercanos a 0.60 aún pueden oscilar entre etiqueta y `uncertain`.

**Umbrales / confianza.** `MIN_CHOICE_PROBABILITY = 0.60` — ilustrativo, no calibrado; en producción elegirlo con ejemplos etiquetados y el coste de errores vs. revisión humana.

**Resultados.**
- Latencia/coste por rúbrica: TypeSafe 114 ms y \$0.000046; LLMs de 826 ms a 13.0 s y 20x–897x más caros (p. ej. gpt-5.5 reasoning 12,978 ms, \$0.041255).
- Desviación estándar media de probabilidades: TypeSafe 0.0098 (máx. 0.0515); Haiku t=0 0.0012 (menor); los otros cinco 0.0245–0.0543 (2.5x–5.6x TypeSafe).
- Acuerdo bruto: TypeSafe 90.8% (flip en 2 de 8 preguntas: `primary_risk` Harassment 11/Violence 4; `link_handling` RmLink 8/Brigade 7). LLMs 87.5%–100%.
- Con la política 0.60: TypeSafe 99.2% de acuerdo, 25.8% uncertain, 74.2% automático, 0 conflictos. Haiku t=0: 100%, sin abstenciones. Otros LLM: 84.2%–94.2%.
- Aviso explícito: mide repetibilidad, no exactitud. `jev-latest` resolvió a `jev-1.13.0` (2026-09-11).

```python
MIN_CHOICE_PROBABILITY = 0.60  # illustrative automatic-action threshold

def choice_decision_with_uncertainty(values: list, labels: list[str]) -> str | None:
    """Abstain below the action threshold; retain invalid results as parse failures."""
    label = argmax_label(values, labels)
    if label is None:
        return None
    probabilities = [float(value) for value in values]
    if any(value < 0 or value > 1 for value in probabilities):
        return None
    return label if max(probabilities) >= MIN_CHOICE_PROBABILITY else "uncertain"

response = typesafe_client.system_one(
    model=model,
    state={"uid": f"{rubric_hash}:{sample_index}:{token_hex(4)}", "post": POST},
    questions=questions,
)
```

---

### 7. Self-consistency: nouls (`cookbooks_consistency_noul_cookbook.md`)

**Problema.** Misma idea que el anterior pero con `Noul` en triage de siniestros de auto (pagar / negar / enviar a humano): ¿se mantiene cada P(true) estable en 15 repeticiones? Umbrales cercanos a 0.5 pueden invertir acciones. Condiciones: Haiku y gpt-5.4-mini (t=0, default y modo yes/no → 1.0/0.0), gpt-5.5 y claude-opus-4-8 razonando, y TypeSafe.

**Diseño de preguntas / state.**
- State = JSON de un siniestro con casos límite incorporados: daño en un track-day pero en el estacionamiento y detenido (la póliza excluye "track/competitive driving"), renta de coche sin cobertura de rental, sin reporte policial (requerido > \$2,000), y una nota de auto-triage que ya lo "aprobó" por el monto completo sin deducible. + `uid` aleatorio por llamada.
- **14 `Noul`** en una llamada (sólo `instructions`, sin criteria), redactadas para que "sí" signifique que lo verificado es verdadero: `covered`, `exclusion`, `on_circuit`, `deductible`, `docs_sufficient`, `within_limit`, `within_window`, `reported_timely`, `rental_eligible`, `fraud_flag`, `human_review`, `manual_review`, `line_items_sum`, `subrogation`.

**Truco clave.** En lugar de un umbral único en 0.5 (0.49 y 0.51 producirían acciones opuestas), una **banda de incertidumbre**: `no` < 0.30, `uncertain` en [0.30, 0.70] inclusive → humano, `yes` > 0.70. Es lógica de aplicación sobre la probabilidad: sin pregunta nueva ni segunda llamada.

**Umbrales / confianza.** `NOUL_UNCERTAINTY_LOW = 0.30`, `NOUL_UNCERTAINTY_HIGH = 0.70` — ilustrativos, no calibrados; fijarlos en producción con ejemplos etiquetados y coste de errores/revisión. Los bordes de la banda también pueden oscilar.

**Resultados.** TypeSafe: 111 ms y \$0.000043 por rúbrica de 14 preguntas; LLMs 1.1–13.9 s y 22x–805x más caros. Desviación estándar media por pregunta de TypeSafe: 0.0102, menor que todas las condiciones LLM con probabilidad. Mayor variación de TypeSafe: `covered` 0.43–0.53 (cruza 0.5) y `exclusion` 0.53–0.62; las otras 13 se quedan de un lado de 0.5. Los LLM se mueven en las preguntas de juicio (`exclusion`, `rental_eligible`, `fraud_flag`, `manual_review`), también a t=0. Nota: Haiku envuelve casi todas las respuestas en ```json aunque se pida sólo JSON. `jev-latest` → `jev-1.13.0` (2026-09-11).

```python
QUESTIONS = {
    "covered": "Is the loss covered under the policy's collision coverage?",
    "exclusion": "Does a policy exclusion apply to this loss?",
    "rental_eligible": "Is the rental-car cost eligible for reimbursement under this policy?",
    "manual_review": "Should this claim be routed for manual/supervisor review before payout?",
    # ... 14 en total
}
questions = {key: Noul(instructions=question) for key, question in QUESTIONS.items()}

def noul_decision_with_uncertainty(probability: float) -> str:
    """Map valid TypeSafe probabilities through an inclusive uncertainty band."""
    if probability < NOUL_UNCERTAINTY_LOW:
        return "no"
    if probability > NOUL_UNCERTAINTY_HIGH:
        return "yes"
    return "uncertain"
```

---

### 8. Date extraction (`cookbooks_date_extraction_cookbook.md`)

**Problema.** `extract_date(document, role)`: dado un documento y una frase que nombra la fecha buscada ("the deadline to return the form"), devolver un `date` con confianza, tanto para fechas absolutas ("August 14, 2027") como relativas ("tomorrow", "next Thursday"), y marcar para revisión las lecturas débiles o fechas que el documento no menciona. El modelo lee lo que dice el texto; **nunca hace aritmética de calendario**.

**Diseño de preguntas / state.**
- State = el texto del documento. **7 `Choice`** en una llamada: `mode` (absolute/relative/none), `month` (12 + none), `day` (1–31 + none), `year` (1900–2050 + `none` + `out_of_range`), `day_anchor` (today/tomorrow/day_after/weekday/none), `weekday` (7 + none), `week_offset` (current/next/none). Muchas opciones con `criteria=None` (sólo la etiqueta).
- El código sólo lee las partes que `mode` requiere (preguntas especulativas).

**Truco clave.** Descomponer la fecha en partes tipadas y resolverla en código contra un `TODAY` fijo (2026-07-30, jueves) para reproducibilidad. Convenciones en código: weekday sin calificador = próxima ocurrencia ≥ hoy; `next` = semana calendario siguiente; `current` = esta semana. Año ausente → año actual, pasado al siguiente si la fecha ya pasó hace > 31 días. Fechas imposibles (30 de febrero) o `out_of_range` → se marcan en vez de adivinar. Sugerencia: si la lista de años molesta, extraer primero en código los números tipo año y ofrecer sólo esos.

**Umbrales / confianza.** Confianza de la fecha = **mínimo** de las confidences de las partes usadas. `REVIEW_BELOW = 0.60`: debajo → humano; también si no se pudo ensamblar.

**Resultados.** 6/6 correctos sobre 4 documentos: contrato (2025-01-01 conf 0.97; 2027-12-31 conf 0.91), formulario sin año (2026-08-14, 0.95), "today" (0.94), "next Thursday" → 2026-08-06 (0.92). La fecha no mencionada ("kickoff call") → `none`, conf 0.46, "absolute date incomplete" → revisión. 5 auto-aceptadas, 1 a revisión. `jev-1.12`.

```python
def assemble(parts: dict, today: date = TODAY) -> dict:
    mode = parts["mode"]["choice"]
    confs = [parts["mode"]["confidence"]]

    def result(resolved: date | None, note: str) -> dict:
        usable = [c for c in confs if c is not None]
        confidence = min(usable) if usable else None
        needs_review = resolved is None or confidence is None or confidence < REVIEW_BELOW
        return {"date": resolved, "confidence": confidence,
                "needs_review": needs_review, "note": note}

    if mode == "relative":
        anchor = parts["day_anchor"]["choice"]
        confs.append(parts["day_anchor"]["confidence"])
        if anchor == "tomorrow":
            return result(today + timedelta(days=1), "")
        # ... today / day_after / weekday -> resolve_weekday(today, weekday, offset)
```

---

### 9. Knowledge graph entity alignment (`cookbooks_entity_alignment.md`)

**Problema.** Decidir si dos entidades de fuentes distintas (dos catálogos de cerveza, benchmark Beer de Magellan) son el mismo producto. 450 pares candidatos ya prefiltrados. Fusionar por error es el fallo caro, así que hace falta una tercera salida: "a curador".

**Diseño de preguntas / state.**
- State = `{"entity_a": {...}, "entity_b": {...}}` (name, brewery, style, abv), texto tal cual publicado (con entidades HTML sin convertir, etc.). Una request por par, `MAX_WORKERS = 6`.
- **1 `Score` de 3 niveles** (`link_state`): 0 = productos distintos → *leave unlinked*; 1 = relacionados, quizá no el mismo (variante, edición especial, nombre ambiguo) → *curator queue*; 2 = el mismo → *assert sameAs*.
- **3 `Noul` compañeras**: `same_name`, `same_brewery`, `same_style` — dicen al curador en qué campo discrepan. ABV no lleva pregunta: comparar números es aritmética, se hace en código.

**Truco clave.** Se usa `Score` (y no Noul con umbral ni Choice) para poner una etiqueta semántica en cada salida, incluida la intermedia, conservando el orden. **No hay constante de umbral que ajustar**: la regla es redondear al nivel más cercano (`route()`); las decisiones se controlan con la redacción de los niveles, que se puede escribir antes de ver un solo score.

**Umbrales / confianza.** Puntos de corte implícitos en 0.5 y 1.5 (redondeo). 47 pares a menos de 0.1 del corte inferior (sólo decide si el curador lo ve) y 9 cerca del superior (el que decide merges). La mayoría de scores caen cerca de 0.25, no en enteros.

**Resultados.** 40 *assert sameAs* (8.9%), 50 *curator queue* (11.1%), 360 *leave unlinked* (80.0%). Ejemplos: c446 score 1.94 conf 0.92 → sameAs; c427 0.03 → unlinked; c100 1.30 conf 0.27 (mismo nombre/cervecería, estilo 0.35) → curador; c428 1.10 (variante con granada) → curador. `jev-1.12`, 2026-08-11.

```python
LEVELS = [
    "They describe two different products.",
    "They describe closely related products that may or may not be the same one: "
    "a variant, a special edition, or a name that could plausibly refer to either.",
    "They describe one and the same product.",
]
OUTCOME = {0: "leave unlinked", 1: "curator queue", 2: "assert sameAs"}

QUESTIONS = {
    "link_state": Score(instructions="How do the two entity descriptions relate as products?", criteria=LEVELS),
    "same_name": Noul(instructions="Do the two entities state the same beer name?"),
    "same_brewery": Noul(instructions="Are the two entities from the same brewery?"),
    "same_style": Noul(instructions="Do the two entities describe the same beer style?"),
}

def route(score_value: float) -> str:
    """The whole decision rule: the nearest level names the outcome."""
    return OUTCOME[min(int(score_value + 0.5), len(LEVELS) - 1)]
```

---

### 10. Function calling (`cookbooks_function_calling.md`)

**Problema.** Convertir peticiones en lenguaje natural de un asistente de trading ("compare nvda amd and msft over the past three months") en llamadas a 10 funciones Python ordinarias con argumentos tipados, sin tocar las funciones. Datos: 156,780 barras de 1 minuto.

**Diseño de preguntas / state.**
- State = el comando del usuario (string).
- `closed_sets` lee las firmas y clasifica los argumentos: **choice** (`Literal` → `Choice` sobre exactamente esos valores), **set** (`list[Literal]` → un `Noul` por miembro, p. ej. "Does the user want {} in the comparison?"), **flag** (`bool` → `Noul`). 28 argumentos rellenables. `int`, texto libre y fechas no llevan pregunta: se queda el default.
- Un `Choice` `__tool__` elige la función entre 10 descripciones. Para argumentos opcionales, una `Noul` extra `stated` ("¿el usuario dice algo sobre este argumento?"): si no, se omite y aplica el default de la función.
- Todo va en **una request por comando: 54 preguntas** (elección de función + argumentos de todas las funciones); el dispatcher sólo lee las de la función elegida.
- `spec.json` contiene pregunta por argumento, una línea por opción y descripción por función; las claves de opción son los strings que acepta la función (sin mapeo posterior). Un LLM puede escribir el spec a partir de las firmas.

**Truco clave.** Preguntas sobre la idea, no sobre las palabras ("is amd tracking nvidia lately" llega a `rolling_correlation` sin que "tracking" aparezca en el spec); no nombrar la pregunta como el parámetro ("Which resolution?" no da nada contra qué emparejar). Roles explícitos para argumentos que comparten dominio (`symbol` "the one being measured, named first" vs. `benchmark` "the yardstick"). La pregunta `stated` evita que un Choice nombre con seguridad una ventana que el usuario nunca dijo.

**Umbrales / confianza.** `confidence` de la llamada = **el juicio menos seguro** (mínimo), no el producto: un solo argumento erróneo basta para arruinar el resultado, y el producto baja con el número de argumentos aunque ninguno sea dudoso. Se expone `call.weakest()`. No se fija umbral numérico en el cookbook.

**Resultados.** 14 comandos resueltos, confianzas de 0.53 a 1.00 (p. ej. `rolling_correlation(symbol='NVDA', benchmark='SPY', window='1mo')` 0.91; `compare_returns([...])` 0.94; `list_symbols()` 1.00; `intraday_pattern(symbol='NVDA')` 0.53). En "is amd tracking nvidia lately": symbol AMD p 0.87, benchmark NVDA p 0.78 (el más débil), window y resolution omitidos. `jev-1.12`.

```python
def plot_price(
    symbol: Literal["SPY", "NVDA", "AMD", "AAPL", "MSFT", "TSLA"],
    style: Literal["line", "candles"] = "line",
    resolution: Literal["1m", "5m", "15m", "1h", "1d"] = "15m",
    window: Literal["1d", "1w", "1mo", "3mo"] = "1w",
    include_volume: bool = False,
    moving_average: Literal["9", "20", "50"] | None = None,
    log_scale: bool = False,
): ...

assistant = Dispatcher(SPEC, TOOLS, client)
CALLS = {command: assistant(command) for command in COMMANDS}
for command, call in CALLS.items():
    print(f'  "{command}"')
    print(f"      {str(call):<66}confidence {call.confidence:.2f}"
          f"   tool {call.tool.probability:.2f}")
```

---

### 11. Hierarchical classification (`cookbooks_hierarchical_classification.md`)

**Problema.** Clasificar un documento bajando por una jerarquía profunda hasta la hoja correcta (taxonomías, filesystems, ontologías, skills de LLM, políticas de moderación…). Cuatro jerarquías: CPC patentes 2026.05, Shopify productos 2026-02, MeSH 2026 (un DAG expandido a rutas por tree-number) y el árbol de archivos del repo CookSafe.

**Diseño de preguntas / state.**
- State = el texto del documento (abstract de patente, listing de producto, abstract clínico, búsqueda de desarrollador).
- En cada nodo, **un `Choice` sobre los hijos directos** ("Which direct child category best matches this document?"), con claves `c0..cN` mapeadas de vuelta a etiquetas. Nodos con un único hijo no hacen llamada (prob 1.0).
- Beam search: en cada nivel se expanden los `K` caminos del beam **en paralelo** (`BEAM_WIDTH = 3`, `MAX_DEPTH = 12`).

**Truco clave.**
- **Greedy** sigue el hijo más probable y no puede recuperarse de un error temprano; **beam** conserva K caminos y la evidencia más profunda repara una decisión temprana ambigua. Como las ramas corren en paralelo, explorar más añade poca latencia.
- Puntuación del camino = media geométrica de las probabilidades de arista: `product(edge_probabilities) ** (1 / decisions)` (normalizada por longitud para comparar hojas someras y profundas). Para árboles muy profundos (> 10 niveles) usar `exp(mean(log(probs)))`.
- Beneficios: observabilidad (en qué nodos se equivoca) y testabilidad (medir el impacto de cambios en la jerarquía).

**Umbrales / confianza.** Métrica `separation = top_path_score / second_path_score` (≈1× ambiguo; grande = separación clara); se reporta pero **no se usa para podar**. Alternativa mencionada: `min(top_prob/second_top_prob)` para favorecer caminos con decisiones claras en cada nodo. `EPSILON = 1e-9`.

**Resultados.** Beam K=3 acertó **4/4** hojas esperadas; greedy **2/4**. Beam recuperó CPC (greedy cayó en "E99Z99/00 Subject matter not otherwise provided for", beam llegó a "A01K31/12 Perches for poultry or birds") y Shopify (greedy "Pet Chairs" vs. beam "Cat Window Beds & Perches"). MeSH (Crohn Disease) y CookSafe (`retrievers.py`) acertaron ambos. `jev-1.12`.

```python
def extend_candidate(candidate: dict, label: str, probabilities: dict[str, float]) -> dict:
    """Append one edge and recompute its geometric-mean path score."""
    is_decision: bool = len(probabilities) > 1
    probability_product: float = candidate["probability_product"] * (
        max(probabilities[label], EPSILON) if is_decision else 1.0
    )
    decision_count: int = candidate["decision_count"] + is_decision
    return {
        "path": candidate["path"] + (label,),
        "probability_product": probability_product,
        "decision_count": decision_count,
        "score": probability_product ** (1 / decision_count) if decision_count else 1.0,
    }

# en cada nivel del beam_search:
        beam = sorted(finished + expanded,
                      key=lambda candidate: candidate["score"], reverse=True)[:BEAM_WIDTH]
```

---

### 12. Guardrails for LLMs (`cookbooks_llm_guardrails.md`)

**Problema.** Filtrar cada mensaje que entra y sale de una app LLM con reglas propias y legibles, sin depender de las negativas entrenadas en el modelo (que cambian por laboratorio y versión), de un system prompt (el lugar que un jailbreak ataca) ni de un segundo LLM (latencia, coste y también jailbreakeable). "Ignore your instructions" puntúa como jailbreak en vez de funcionar como uno.

**Diseño de preguntas / state.**
- State = el texto del mensaje. Una request por mensaje con toda la batería.
- **Batería de entrada:** 4 `Noul` con criteria true/false (`jailbreak`, `harmful_request`, `medical_advice`, `self_harm`) + 1 `Score` `severity` de 4 niveles (No harm / Mild / Serious / Severe).
- **Batería de salida:** las mismas 4 preguntas desde el lado de la respuesta (`broke_policy`, `harmful_request`, `medical_advice`, `self_harm`) + el mismo `severity`.
- Datos: 10 prompts y 5 respuestas; los jailbreaks son reales (dataset in-the-wild jailbreak prompts).

**Truco clave.** TypeSafe da la evaluación; la aplicación posee la decisión. Cada hazard tiene una acción configurada (`jailbreak`/`broke_policy`/`harmful_request` → block; `medical_advice` → review; `self_harm` → **support**, una ruta de crisis en vez de bloquear). Precedencia: support > block > review > pass. Una política es sólo un conjunto de números con nombre; el mismo resultado cacheado se puede re-rutear con otra política sin nueva llamada. Ejecutarlo en entrada **y** salida, porque prompts normales pueden producir respuestas dañinas.

**Umbrales / confianza.** Dos umbrales por Noul: ≥ `action_threshold` dispara la acción del hazard; ≥ `review_threshold` → humano. El `severity` ≥ `severity_block` convierte un review en block. Políticas: `strict` = {review 0.35, action 0.70, severity_block 2.0}; `permissive` = {review 0.35, action 0.85, severity_block 2.0}. Fijarlos con ejemplos etiquetados del propio tráfico.

**Resultados (política strict).** Entrada: banana_bread/https/prescription_info → pass; melatonin_dose (medical 0.55) → review; dosage_request (medical 0.95, sev 2.02) → block (la severidad convirtió review en block); novelist_poison (sev 0.8) → pass; lockpick_burglary (0.95) → block; self_harm (0.96) → support; DAN (0.98) → block; neurosemantical (jailbreak 0.74) → block. Salida: good_refusal → pass; dosage_request (0.98) y jailbroken (broke_policy 0.94) → block. El mismo neurosemantical con `permissive` → review. `jev-1.12`, 2026-08-15.

```python
HAZARD_ACTION = {
    "jailbreak": "block", "broke_policy": "block", "harmful_request": "block",
    "medical_advice": "review",  # Routes to a human review path instead of blocking it
    "self_harm": "support",      # Routes to a support path instead of blocking it
}
PRECEDENCE = ["support", "block", "review", "pass"]  # Highest precedence wins
POLICIES = {
    "strict": {"review_threshold": 0.35, "action_threshold": 0.70, "severity_block": 2.0},
    "permissive": {"review_threshold": 0.35, "action_threshold": 0.85, "severity_block": 2.0},
}

def route(nouls: dict[str, float], severity: float, policy: dict) -> str:
    triggered = []
    for hazard, probability in nouls.items():
        if probability >= policy["action_threshold"]:
            triggered.append(HAZARD_ACTION[hazard])
        elif probability >= policy["review_threshold"]:
            triggered.append("review")
    if severity >= policy["severity_block"]:
        triggered = ["block" if action == "review" else action for action in triggered]
    return next((action for action in PRECEDENCE if action in triggered), "pass")
```

---

### 13. Parallel questions (`cookbooks_parallel_questions.md`)

**Problema.** Con un documento y N preguntas, ¿conviene una request con las N o N requests de una? Demuestra que en TypeSafe cada pregunta se puntúa por separado contra el documento, así que la respuesta no depende de las otras preguntas del batch; sólo cambian coste y velocidad. Caso: briefing regulatorio sobre el artículo de Wikipedia del GDPR (revisión fijada, 53,777 caracteres).

**Diseño de preguntas / state.**
- State = `{"article": {"source": url, "text": ...}}`.
- **13 preguntas**: 8 `Noul` (breach en 72 h, aplica fuera de la UE, DPO obligatorio para todos, consentimiento con casillas pre-marcadas, derecho de supresión, portabilidad, ¿es ley federal de EE.UU.?, penas criminales), 2 `Choice` (tipo de instrumento: Regulation/Directive/Treaty/Recommendation; multa máxima: 20M o 4% / 10M o 2% / fija / sin multas), 3 `Score` (fuerza de derechos individuales, severidad de sanciones, carga de cumplimiento; 4–5 niveles).
- Métrica seguida por tipo: Noul → p(yes); Choice → probabilidad máxima; Score → score normalizado 0–1 (score / nivel máximo).
- 5 repeticiones por estrategia (`RUNS = 5`).

**Truco clave.** El documento domina el tamaño de cada request: N llamadas lo pagan N veces en N round trips; el batch lo paga una vez. Cuanto mayor el documento, más se acerca el ahorro a Nx. (La comparación de velocidad suma las 13 latencias secuenciales; en concurrente la brecha se reduce, pero el coste 13x se mantiene.)

**Umbrales / confianza.** No aplica umbral; se compara media y desviación estándar entre estrategias.

**Resultados.** Choices, Scores y 6 de 8 Nouls idénticos en las 5 repeticiones (std 0.0) en ambas estrategias. `breach_72h` (0.804 vs 0.814, std 0.0055 en ambas) y `criminal_penalties` (0.108 vs 0.108; std 0.0045 vs 0.0084) tienen ruido propio de la pregunta, del mismo tamaño en ambas. Coste/tiempo: batch \$0.000497 y 0.27 s vs. 13 llamadas \$0.006090 y 2.71 s → **12.2x más barato, 10.0x más rápido**. `jev-1.12`, precio (0.042, 0.00) \$/1M.

```python
@json_cache
def ask(keys: tuple[str, ...], run: int):
    started = perf_counter()
    response = client.system_one(
        state={"article": DOCUMENT},
        questions={key: QUESTIONS[key] for key in keys},
        model=TYPESAFE_MODEL,
    )
    values = {}
    for key in keys:
        answer = response.answers[key]
        if isinstance(answer, NoulAnswer):
            values[key] = answer.noul
        elif isinstance(answer, ChoiceAnswer):
            values[key] = max(answer.probabilities.values())
        else:
            values[key] = answer.score / (len(QUESTIONS[key].criteria) - 1)
    return (values, response.usage.input_tokens, response.usage.output_tokens,
            perf_counter() - started)

batched = [priced(ask(tuple(QUESTIONS), run)) for run in range(RUNS)]
singles = [{key: priced(ask((key,), run)) for key in QUESTIONS} for run in range(RUNS)]
```

---

### 14. Pre-parsed value extraction (`cookbooks_pre_parsed_value_extraction_cookbook.md`)

**Problema.** Extraer valores exactos (emails, teléfonos, montos) sin que el modelo pueda inventar un valor o transponer un dígito. Patrón en tres pasos: (1) un regex ajustado para sobre-encontrar candidatos; (2) TypeSafe elige cuál candidato es el que pide la pregunta y lee atributos necesarios (moneda, país, crédito vs. cargo); (3) el código copia el valor elegido y lo normaliza.

**Diseño de preguntas / state.**
- State = el documento (email, texto con teléfonos, factura).
- `pick`: un `Choice` cuyas **opciones son los spans literales** que encontró el regex + la escotilla `"none"` ("None of these is the requested value."). Así la respuesta es una copia exacta de un span.
- `classify`: `Choice` sobre etiquetas fijas (país `US/GB/DE/FR/CA/AU`, moneda `USD/EUR/GBP/JPY/CAD`).
- `is_true`: `Noul` (¿este monto es un crédito/reembolso, no un cargo?).
- Cada helper es una request de una pregunta.

**Truco clave.** "El modelo elige, el código es dueño del string." La normalización la hace código (`.lower()`, `phonenumbers` a E.164 con el país que leyó el modelo, `Decimal`). Para el formato numérico ambiguo (`€1.315,50`), preguntar con un Noul qué convención usa el documento y ramificar en código.

**Umbrales / confianza.** Crédito si P(credit) > 0.5. Las confidences se reportan (0.90–1.00) pero no se usa umbral de revisión.

**Resultados.** Email: receipt → `dana.personal@gmail.com` (conf 0.98, el Reply-To que pide el cuerpo, no el alias billing del To); sender → `dana.whit@acme-corp.com` (1.00). Teléfono: móvil `(415) 555-0177` (1.00), país US (0.90) → `+14155550177`. Factura: total \$1,315.50 → 1315.50 USD (P(credit) 0.01, cargo); crédito \$50.00 (P(credit) 0.99). Límites: un `Choice` admite **máximo 255 opciones** (si hay más, dos etapas: primero sección, luego span); los nombres propios no tienen regex, sus candidatos deben venir de un roster, NER o un LLM. `jev-1.12`.

```python
@json_cache
def pick(document: str, candidates: list[str], question: str) -> dict:
    """The options ARE the candidate spans, so ``choice`` is a verbatim copy of one of them (or the
    ``none`` hatch) - the model chooses, code owns the string."""
    criteria = {c: None for c in candidates} | {
        NONE: "None of these is the requested value."
    }
    answer = ts.system_one(
        state=document,
        questions={"pick": Choice(instructions=question, criteria=criteria)},
        model=TYPESAFE_MODEL,
    ).answers["pick"]
    return {"choice": answer.choice, "confidence": answer.confidence}

phones = find(PHONE_RE, PHONE_DOC)
mobile = pick(PHONE_DOC, phones, "Which of these is the direct mobile / cell number?")
region = classify(PHONE_DOC, "In what country is this office located?", ["US", "GB", "DE", "FR", "CA", "AU"])
parsed = phonenumbers.parse(mobile["choice"], region["choice"])
e164 = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
```

---

### 15. Re-ranking (`cookbooks_rerank_typesafe.md`)

**Problema.** Búsqueda en dos pasos: una búsqueda rápida (BM25) reduce miles de documentos a una shortlist, y un re-ranker pone primero el correcto. Datos: CLERC (retrieval legal), 3,565 pasajes de opiniones judiciales de EE.UU. (170 filas agrupadas), 40 queries; cada query es un extracto de opinión con una cita eliminada y el "gold" es el pasaje citado.

**Diseño de preguntas / state.**
- State = `{"query_excerpt": ..., "candidate_passage": ...}` (un par por request; ninguna request ve a otra).
- **1 `Noul`** `is_cited_source` con criteria detalladas: true = el candidato establece la regla/estándar/holding/patrón de hechos específico que el extracto atribuye a la cita eliminada; false = sólo es de un tema o doctrina similar.
- `TOP_K = 30` candidatos por query → 40 × 30 = 1,200 llamadas concurrentes (`max_workers=12`).

**Truco clave.** El valor noul (0–1) *es* el score de ranking: no hay que inventar una escala para un LLM generalista; se ordena la shortlist por noul descendente. El re-ranker sólo reordena: no puede añadir un pasaje que la búsqueda rápida no seleccionó (aquí la shortlist contenía el correcto en 100% de las queries). Nota: una aplicación real haría varias preguntas por par en una llamada (ver parallel questions y fan-out).

**Umbrales / confianza.** No hay umbral; sólo ordenamiento.

**Resultados.** Top-1: 5% → 18%; Top-5: 15% → 35%; Top-10: 38% → 62%. 1,200 llamadas, 1,536,002 tokens de entrada y 25,200 de salida, \$0.0645. `jev-1.12`.

```python
is_cited_source = Noul(
    instructions=(
        "The query excerpt comes from a US federal court opinion and was written "
        "immediately around a citation to a precedent; the citation itself has been "
        "removed. Could the candidate passage be from that cited precedent — does it "
        "establish the specific legal proposition the query excerpt invokes at its "
        "citation point?"
    ),
    criteria=NoulCriteria(
        true=("The candidate passage states or establishes the specific rule, standard, "
              "holding, or fact pattern that the query excerpt attributes to its removed citation."),
        false=("The candidate passage is merely on a similar topic or doctrine; it does not "
               "supply the specific proposition the query excerpt relies on."),
    ),
)
response = client.system_one(
    state={"query_excerpt": query, "candidate_passage": candidate},
    questions={"is_cited_source": question}, model=model,
)
reranked = {q: sorted(candidates[q], key=lambda c: -pair_scores[q][c]["noul"]) for q in queries}
```

---

### 16. SDE cascade (`cookbooks_sde_cascade.md`)

**Problema.** Extracción de datos estructurados (SDE): los modelos de razonamiento grandes lo hacen bien pero son lentos y caros; los pequeños son baratos pero se equivocan. Cascada: (1) extraer con `gpt-5.4-mini` (\$0.75/\$4.50 por 1M), (2) verificar con TypeSafe `jev-1.12` (\$0.042/\$0.00), (3) escalar a `gpt-5.5` con `reasoning_effort="high"` (\$5.00/\$30.00, ~7x el mini) sólo si una señal del verificador se dispara. Ejemplo: fila 516 del dataset `scrapegraphai/scrapegraphai-100k` (página de calendario de NYU sin fecha de registro).

**Diseño de preguntas / state.**
- State estructurado: `{system_message, instruction, source_text, schema, extraction}`.
- Batería de `Noul` **por campo**, con `instructions` también estructuradas (`{field_spec, extracted_field, main_question}`), claves `field::metric`, todas en una llamada:
  - Campos no vacíos: `name_desc_mismatch`, `type_mismatch`, `unreasonable`, `hallucinated`, `off_target`, `incomplete`, `format_violation`.
  - Campos vacíos: sólo `absence_wrong` ("¿la fuente sí contiene la información, haciendo incorrecto el vacío?").
  - Una cabeza holística `__overall__::judge` que se muestra para contraste pero **no** se usa en la compuerta.
  - (El pipeline completo tiene además un head `spurious` y un score `difficulty`, no mostrados.)
- Todas redactadas para que **true = algo está mal** (escalar).

**Truco clave.** "The TypeSafe Way: Decomposition": descomponer programáticamente en preguntas estrechas por campo maximiza la inteligencia de cada prompt y hace el algoritmo ajustable e interpretable. La validación JSON Schema es necesaria pero no suficiente: el registro del mini era schema-valid y aun así inventaba `description` (copiaba el ejemplo del propio schema). Compuerta estilo **`max`** (escalar si *cualquier* campo dispara), no media, para que una señal fuerte no se diluya.

**Umbrales / confianza.** `FIRE_T = 0.7`: escalar si cualquier P(wrong) por campo > 0.7.

**Resultados.** En el ejemplo: `description::hallucinated` 0.95 y `description::off_target` 0.85 dispararon; `__overall__::judge` sólo 0.56 (el juez holístico no habría bastado); `registration_open_date::absence_wrong` 0.14 (correctamente vacío). El modelo de razonamiento devolvió `description: ""`. En 100 prompts (resultados internos de TypeSafe, barrido del umbral 0→1): la frontera de Pareto de la cascada queda arriba-izquierda de todos los modelos individuales; `gpt-5.5-reasoning` solo ≈ 0.81 de calidad a ≈ \$0.10/extracción. (Gráfico histórico, costes no recalculados a la tarifa actual.) Apéndice: una buena señal de verificador es estrecha y anclada, "malo = TRUE" con criterios explícitos, por campo y agregada con `max`, independiente y barata, y separadora/calibrada.

```python
def build_questions(record: dict) -> dict[str, Noul]:
    questions = {"__overall__::judge": Noul(instructions=OVERALL_JUDGE, criteria=OVERALL_JUDGE_CRITERIA)}
    for name, value in record.items():
        spec = field_spec(name)
        if is_empty(value):
            questions[f"{name}::absence_wrong"] = Noul(
                instructions={"field_spec": spec, "extracted_field": value,
                              "main_question": ABSENCE_QUESTION},
                criteria=ABSENCE_CRITERIA,
            )
            continue
        for metric, (question, criteria) in MAIN_QUESTIONS.items():
            questions[f"{name}::{metric}"] = Noul(
                instructions={"field_spec": spec, "extracted_field": value,
                              "main_question": question},
                criteria=criteria,
            )
    return questions

fired = {qid: p for qid, p in checks.items()
         if not qid.startswith("__overall__") and p > FIRE_T}
escalate = bool(fired)
```

---

### 17. Line-by-line search (`cookbooks_semantic_find.md`)

**Problema.** Búsqueda semántica dentro de un documento (Términos de Servicio de GitHub, 218 cláusulas, 43,980 caracteres): devolver las líneas que responden una pregunta en lenguaje llano y detectar cuándo el documento **no** tiene la respuesta. Resultado: `find()` devuelve la probabilidad `exists` y un score de relevancia por línea.

**Diseño de preguntas / state.**
- State = el documento con cada línea prefijada por un id (`L052| ...`); **el state no cambia entre búsquedas**, la query va en `instructions`.
- **1 `Choice` `where`** cuyas opciones son los 218 ids de línea (`criteria` = `None`, porque el texto ya está en el documento): "elegir una opción" se convierte en "apuntar a una línea".
- **1 `Noul` `exists`** en la misma request: "Does any line of the document address or answer: …?", con criteria true/false.

**Truco clave.** Las probabilidades de un Choice siempre suman 1, así que *alguna* línea queda primera aunque ninguna responda; el Noul no depende de las otras opciones y puede caer cerca de cero. "El ranking dice dónde mirar; `exists` dice si el resultado responde la pregunta." El state se envía una vez, así que añadir la verificación de existencia cuesta muy poco output extra. Límite: un Choice acepta hasta 255 opciones → documentos de hasta 255 líneas por request; más allá, dos pasadas (un Choice elige ventana, otro rankea dentro).

**Umbrales / confianza.** `FOUND, ABSENT = 0.7, 0.35` (respuestas presentes suelen leer ≥ 0.9, ausentes ≤ 0.05): `exists` ≥ 0.7 → "answered", < 0.35 → "not in this document", intermedio → "partially addressed". Ajustarlos a los propios documentos antes de producción.

**Resultados.** "who owns the code I upload?" → exists 0.98, L052 0.95. "can GitHub kick me off…?" → exists 0.97, L168 0.97. "do I have to take disputes to arbitration?" → la mejor línea tenía 0.86 pero exists 0.14 → no está en el documento. "can minors use GitHub with parental permission?" → exists 0.46 → parcialmente (la regla de edad L029 0.90 no responde lo del permiso parental). `jev-1.12`.

```python
DOCUMENT = "\n".join(f"{line_id(i)}| {line}" for i, line in enumerate(LINES))

def where_question(query: str) -> Choice:
    return Choice(
        instructions=f'Which line of the document contains the answer to: "{query}"?',
        criteria={line_id(i): None for i in range(len(LINES))},
    )

def exists_question(query: str) -> Noul:
    return Noul(
        instructions=f'Does any line of the document address or answer: "{query}"?',
        criteria=NoulCriteria(
            true="At least one line of the document states or directly implies the answer",
            false="No line of the document addresses this",
        ),
    )

FOUND, ABSENT = 0.7, 0.35  # present answers typically read >=0.9, absent <=0.05

def verdict(exists: float) -> str:
    if exists >= FOUND:
        return "answered in this document"
    return "not in this document" if exists < ABSENT else "partially addressed"
```

---

### 18. Skill suggestion (`cookbooks_skill_suggestion.md`)

**Problema.** Los agentes eligen skills a partir de un índice con descripciones truncadas (Hermes corta a 60 caracteres), lo que encarece, empeora la selección y produce context rot. Por ejemplo, la skill que *edita* `.pptx` se lee casi igual que la que *los crea*. Objetivo: sugerir **como máximo una** skill por turno de entre las 182 del catálogo Hermes (Nous Research, 33 categorías), o ninguna. Se evalúa con 488 requests (315 cubiertas por exactamente una skill, 173 sin skill: 85 cotidianas, 42 preguntas técnicas, 46 que piden algo que el roster no cubre, p. ej. Mastodon cuando sólo hay skill de X). Agente: `claude-haiku-4-5-20251001`.

**Diseño de preguntas / state.** State = `{"request": ..., "recent_context": ""}`. Divulgación progresiva en **dos requests**:
- **Request 1 (rank_wide):** 1 `Choice` `which` sobre las 182 skills (criteria = la descripción del índice, la misma que ve el agente) + **3 `Noul` de compuerta**: `acts_on_user_system`, `would_follow_documented_procedure`, `prose_suffices` (invertida). Su media decide si se sugiere algo.
- **Request 2 (rerank):** 1 `Choice` sobre el top-3 (`SHORTLIST = 3`) con descripción completa + primeros `EXCERPT_CHARS = 700` caracteres del `SKILL.md`, + 1 `Noul` `fits::{name}` por candidato ("¿hace esta skill lo que pide la request?").
- El ganador se inyecta como un bloque `<skill_relevance>` **después** del roster (el roster no cambia, se mantiene el prefix caching), diciendo que puede ignorarse; si no hay skill se envía igual una frase "No skill… appears relevant" para contrarrestar el "err on the side of loading" del prompt de Hermes.

**Truco clave.** Las preguntas de compuerta deben preguntar si se quiere **una acción**, no por tema (el tema no separa "explica qué es una mónada" de una request que necesita skill). El Choice decide *cuál* skill; las Nouls `fits` deciden *si* decir algo: pueden discrepar (en el deck, `fits` prefería `powerpoint` 0.73 pero el Choice eligió `pptx-author`, que es lo correcto). Para rosters varias veces mayores: dividir en chunks, rankear cada uno y aplicar el shortlist sobre los ganadores.

**Umbrales / confianza.** `GATE_THRESHOLD = 0.30` (media de las 3 Nouls orientadas; debajo, nada). `FITS_THRESHOLD = 0.30` (si el mejor `fits` del shortlist < 0.30, se descarta).

**Resultados.**

| | carga skill equivocada | carga skill cuando nada aplica |
|---|---|---|
| Agente solo | 16.8% | 9.8% |
| **Agente + sugerencia TypeSafe** | **7.3%** | **4.0%** |
| Agente con la respuesta (oráculo) | 2.5% | 1.2% |

2.3x menos cargas erróneas y 2.4x menos innecesarias. De 315 cubiertas: 37 arregladas, 7 rotas por la sugerencia (una sugerencia errónea y segura es más persuasiva que ninguna). De 36 errores del baseline, 10 eran de la misma categoría que la skill correcta. Latencias por request 0.09–0.31 s. Caso no resuelto: Mastodon → sugiere `xurl` (X) porque el segundo paso sólo puede rechazar lo que le pasa el primero. `jev-1.12`, 2026-07-31.

```python
def suggest(request: str) -> tuple[str, ...]:
    """At most one skill name for a request, or () for "nothing here applies"."""
    wide = rank_wide(request)
    if wide["gate"] < GATE_THRESHOLD:
        return ()
    shortlist = tuple(name for name, _ in wide["ranked"][:SHORTLIST])
    result = rerank(request, shortlist, EXCERPT_CHARS)
    if max(result["fits"].values()) < FITS_THRESHOLD:
        return ()
    return (result["winner"],)

# dentro de rank_wide:
    questions = {"which": Choice(instructions=CHOICE_INSTRUCTIONS,
                 criteria={skill["name"]: skill["description"] for skill in ROSTER})}
    for key, text in GATE_QUESTIONS.items():
        questions[f"gate::{key}"] = Noul(instructions=text)
    ...
    oriented = [(1.0 - v) if k in INVERTED else v for k, v in values.items()]
```

---

### 19. Demo: Smart Home Assistant (`demos.md`, `demos_smart-home.md`)

`demos.md` lista una sola demo: **Smart Home Assistant**, que evalúa peticiones de hogar inteligente con preguntas especulativas y fallback a LLM (hay video Loom).

- **Patrón principal: speculative fan-out.** Cada petición se evalúa contra una lista larga de preguntas, muchas irrelevantes para esa petición. Ej.: "Turn off all of the lights in the house" sólo necesita: categoría (smarthome command), dominio (whole house), tipo de dispositivo (lights), acción sobre las luces (turn off). La última es una "pregunta especulativa": se hace antes de saber si es relevante, para evaluar todo en paralelo y filtrar en código después.
- **La forma incorrecta:** llamadas secuenciales (categoría → dominio/dispositivo → acción) minimizan el número de preguntas pero son más lentas y caras que un único batch por adelantado.
- **Emparejamiento con LLM:**
  - Una `Noul` detecta si la petición pide más de una acción distinta; si sí, un LLM la divide en comandos atómicos, y cada uno se evalúa de nuevo con TypeSafe.
  - Si TypeSafe determina que es una petición de información general o conversación, se llama a un LLM para respuesta libre. La respuesta inicial de TypeSafe es tan rápida frente al LLM que añade latencia despreciable.
- **Implementación:** SPA Vite/React que usa la API de TypeSafe; el código fuente "estará disponible en GitHub al lanzamiento" con README de instrucciones.
- No incluye métricas ni fragmentos de código.

---

### 20. Mapa de casos de uso por industria (`concepts_use-case-map.md`)

**Categorías generales (cards):**
- **AI Automation Software:** intercalar IA con software fiable que puede correr un millón de veces en segundo plano sin copiloto humano; el código controla el flujo (no archivos markdown) y TypeSafe hace las decisiones semánticas.
- **Real-time applications:** inteligencia "frontier" a velocidad de tiempo real (150 ms), más rápida que la percepción humana; programable para jugar juegos o embebida en UI.
- **AI Map Reduce over Big Data:** "100x más barato" → procesar datasets gigantes: buscar en corpus enormes, clasificar trazas de agentes, extraer features para predicciones.
- **Universal Verification:** verificar prompts de entrada, extracciones, trazas de razonamiento, tool calls o inputs de cualquier otra IA; detectar jailbreaks, errores de cita, alucinaciones, a una fracción del coste de la llamada LLM.
- **Harness Engineering:** routing de modelos, recuperación semántica de contexto, detección de errores/guardrails de LLM, clasificación de trazas de razonamiento.

**Por industria / dominio:**

| Dominio | Ejemplos de decisiones |
|---|---|
| Search & retrieval | Reemplazar o complementar embeddings en RAG; puntuar relevancia query–candidato; rerank por comparaciones por pares; cross-encoding; seleccionar contexto útil. |
| Scientific discovery | Cribar papers por criterios de inclusión/exclusión (revisiones sistemáticas); etiquetar pasajes de entrevistas/encuestas/notas de campo por temas; verificar que las citas respaldan afirmaciones; detectar detalles metodológicos faltantes (controles, datasets, settings); entidades y relaciones para grafos de conocimiento de investigación. |
| Model routing | Router propio que elige qué LLM recibe cada prompt; reglas y umbrales propios; clasificar intención y dominio; estimar dificultad y riesgo; escalar a un modelo más caro. |
| LLM guardrails | Chequeos semánticos en cada input, output y tool call; jailbreaks y prompt injection; violaciones de política y exposición de datos sensibles; errores de tool calls y fallos de calidad en tiempo real; loguear resultados estructurados con probabilidades. |
| Semantic code linting | Lints semánticos para código y escritura; convenciones del equipo y guías de estilo; correr en CI y marcar violaciones. |
| Feature extraction para modelado predictivo | Features probabilísticas desde lenguaje natural; combinarlas con datos estructurados para entrenar modelos con ground truth; workflows de autoresearch que proponen y evalúan features contra ground truth reservado. |
| Recruiting | Evaluar CVs, aplicaciones y feedback de entrevistas contra criterios del puesto; experiencia relevante; evidencia de competencias; matching candidato–rol; ruteo a hiring managers/recruiters; escalar casos inciertos a revisión humana. |
| Lead generation | Emparejar perfiles de empresa, biografías de ejecutivos y mensajes inbound con el ICP; puntuar fit de industria y madurez; detectar relevancia del comprador, pain points e intención de compra; priorizar y rutear leads. |
| Customer support | Clasificar tickets por problema, área de producto e intención; procesar transcripciones de llamadas (problemas, compromisos, follow-ups); detectar urgencia, frustración, riesgo de churn y solicitudes de reembolso; rutear a equipo/cola/workflow; verificar respuestas contra políticas y la petición del cliente. |
| Insurance claims | Clasificar FNOL, notas de ajustador y documentos; detectar complejidad, información faltante e indicadores de fraude; priorizar straight-through processing vs. especialista; escalar casos inciertos o de alto riesgo a un ajustador humano. |
| Financial crime | Evaluar narrativas de transacciones, documentos KYC e historiales de alertas; emparejar entidades con nombres/perfiles inconsistentes; priorizar alertas por riesgo, relevancia y calidad de evidencia; rutear casos ambiguos a investigadores. |
| Legal & compliance | Clasificar contratos, políticas, filings regulatorios y claims de marketing; detectar cláusulas faltantes, claims prohibidos y violaciones; verificar contra requisitos legales explícitos; escalar hallazgos de alto riesgo o inciertos a legal/compliance. |
| E-commerce marketplaces | Clasificar y normalizar listings entre catálogos inconsistentes; extraer atributos de títulos y descripciones; detectar listings prohibidos, señales de falsificación, abuso de reseñas; rankear productos y rutear listings inciertos a revisión humana. |
| Moderation / trust & safety | Criterios propios y matizados de moderación; moderar contenido y conversaciones automatizadas (comunidades, soporte, **flujos SDR**); detectar toxicidad, acoso, spam, fraude, consejos inseguros, exposición de datos personales, **solicitudes de opt-out** y claims que violan políticas; combinar severidad y confianza para allow / warn / review / block. |
| Advertising | Evaluar creatividades, copy, landing pages y contexto de ubicación; brand safety y adecuación de audiencia; compliance regulatorio y claims prohibidos; calidad creativa y alineación anuncio–landing. |
| Gaming | Reportes de jugadores, chat in-game, reseñas y conversaciones de soporte; moderar chat, detectar abuso/toxicidad/comportamiento sospechoso; anotar contenido y puntuar frustración o engagement; detectar churn y rutear soporte. |
| Risk assessment | Convertir reportes de incidentes, notas de siniestros, descripciones de transacciones y evaluaciones de proveedores en indicadores de riesgo probabilísticos; uso en seguros y underwriting; clasificar tipos de riesgo; puntuar severidad y priorizar; features para modelos de riesgo. |
| Demand forecasting | Enriquecer modelos de forecasting con señales semánticas de consultas, notas de ventas, reseñas, tickets e informes de mercado; extraer intención de compra, urgencia e interés por producto; detectar problemas de suministro, presión competitiva y temas de demanda emergentes; alimentar el modelo junto con series temporales. |
| Graphs & knowledge graphs | Anotar y verificar grafos con decisiones semánticas tipadas; clasificar relaciones y tipos de entidad; detectar contradicciones entre registros; soportar traversal probabilístico y clasificación jerárquica. |

**Formas de decisión (task categories):**

| Forma | Cuándo | Ejemplos |
|---|---|---|
| Classification | Debe ganar una categoría conocida | Intención, tema, departamento, tipo de riesgo, tipo de entidad |
| Detection | Probabilidad de que una propiedad esté presente | Spam, fraude, urgencia, jailbreaks, datos sensibles |
| Scoring | La respuesta vive en una rúbrica ordenada | Severidad, relevancia, calidad, frustración, adecuación |
| Routing | Una categoría elige el siguiente camino de código | Uso de tools, escalamiento, model routing, colas de soporte |
| Search | Encontrar ítems que casan con una query en lenguaje natural | Búsqueda semántica, descubrimiento de documentos, generación de candidatos |
| Retrieval | Un workflow necesita el contexto o registros más relevantes | Contexto RAG, recuperación de evidencia, lookup de conocimiento |
| Ranking | Ordenar ítems por relevancia semántica o calidad | Resultados de búsqueda, recomendaciones, priorización de candidatos |
| Verification | Revisar un artefacto contra modos de fallo específicos | Soporte de citas, violaciones de política, errores de tool calls, calidad de respuesta |
| ML Feature Extraction | Un modelo ML clásico necesita señales semánticas | Intención de compra, interés de producto, presión competitiva, churn |
| Structured Data Extraction | Recuperar campos conocidos de input no estructurado | Atributos de candidatos, campos de pedidos, etiquetas de documentos |

---

### Patrones transversales (observados en los cookbooks)

- **Una request, muchas preguntas** (fan-out especulativo / preguntas compañeras): el state domina el coste; batching no cambia respuestas (parallel questions: 12.2x más barato, 10.0x más rápido). Usado en autoformat, date extraction, function calling (54 preguntas), guardrails, semantic find, demo smart home.
- **El modelo elige, el código calcula**: fechas, E.164, `Decimal`, aritmética de ABV, merge de líneas y render de Markdown quedan en código; TypeSafe sólo juzga.
- **Umbrales en código, no en la pregunta**: RAG (`THRESHOLDS` dict), guardrails (`POLICIES` con nombre), SDE (`FIRE_T`), re-rutear sin llamadas nuevas.
- **Zona de incertidumbre → humano**: citation 0.8, clasificación 0.9 (o subir de nivel jerárquico), consistencia Choice 0.60, banda Noul 0.30–0.70, fechas 0.60, semantic find 0.35/0.7, nivel intermedio del Score en entity alignment.
- **Agregación por mínimo/máximo**: confianza = parte más débil (fecha, function call); escalado = cualquier señal por campo (SDE, `max`).
- **Límites de Choice citados**: "funciona de forma fiable hasta ~240 opciones" (classification using confidence) y "máximo 255 opciones" (pre-parsed extraction, semantic find). `Score`: máximo 10 niveles (11 da error; autoresearch).
- **Modelos/precios citados**: `jev-1.12` a \$0.042 / \$0.00 por 1M tokens (input/output); `jev-latest` resolvió a `jev-1.13.0` en septiembre de 2026.
