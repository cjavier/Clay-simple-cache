# 3. Cómo diseñar `state`, preguntas y umbrales

> Esta es la parte que más determina la calidad. La API es trivial. Lo difícil es **escribir buenas preguntas**.
> Fuentes: `/concepts/state`, `/primitives/*`, `/confidence`, `/concepts/how-to-build-with-system-one`, `/model-jaggedness/jev-1.13`.

## 3.1 El `state`

- Es "el material que le presentarías a un panel de expertos antes de pedirles un juicio".
- Puede ser un **string** (un mensaje suelto), un **objeto**, que es lo recomendado casi siempre porque cada parte queda nombrada, o un **array** (secuencia de mensajes o registros).
- **Pon en el mismo state lo que la decisión necesita comparar.** Por ejemplo: el ticket, la orden y la política de reembolso.
- **Manda solo lo relevante.** Jev sufre *context rot*: el detalle irrelevante distrae y baja la precisión. Filtra y recupera en código primero.
- No dependas del conocimiento en los pesos del modelo cuando puedes traer el dato actual de tu propia base.
- Límite: 32k tokens para state + la pregunta más larga, y 64k en total.

### Referenciar campos con rutas en backticks

```json
"instructions": "Does `ticket.messages[0].text` request a refund?"
"instructions": "Does `refund_policy` support the refund requested in `ticket.messages[0].text`, given `order.charges`?"
```

Las rutas con punto e índice, **incluyendo los backticks**, le dicen al modelo exactamente qué parte del state juzgar.

## 3.2 Elegir la primitiva

| Si la respuesta es… | Usa | Tu código hace |
|---|---|---|
| Una de un conjunto conocido, sin orden | **Choice** | `switch (choice)` |
| Una posición en un espectro que puedes describir por niveles | **Score** | umbral o ranking sobre `score` |
| Un sí/no limpio | **Noul** | `if (noul > umbral)` |

Cuando dos primitivas parecen servir, elige la que tu código pueda consumir más directo.

**Trampa clásica:** "¿El candidato es fuerte en Python?" como Noul. Un `0.5` **no** significa "nivel medio". Significa que el modelo reparte la probabilidad entre sí y no. Si quieres medir un grado, usa un Score con niveles:

| Candidato | Noul "strong in Python?" | Score (4 niveles) |
|---|---|---|
| Nunca usó Python | 0.03 | 0.0 (sin experiencia) |
| Scripts ocasionales | 0.14 | 1.0 (algo de familiaridad) |
| 2 años diario en el trabajo | 0.81 | 2.05 (uso regular) |
| 8 años, mantiene Django grande | 0.92 | 2.89 (experto) |

## 3.3 Reglas de oro para escribir preguntas

1. **Un juicio por pregunta.** Si piensas "¿está enojado **y** pide reembolso?", haz dos Nouls y combínalos en código.
2. **Juicio de segundos.** "¿Este mensaje transmite urgencia?" funciona. "Analiza el mensaje y determina el mejor curso de acción" no.
3. **Descompón lo complejo.** No preguntes "califica este pitch". Pregunta por tamaño de mercado, factibilidad y diferenciación por separado y pondéralos en código. Cuando cambien las prioridades, cambias un coeficiente y no un prompt.
4. **La pregunta completa va en `instructions`.** El id (`refund_requested`) no llega al modelo.
5. **Jev lee literal.** Contesta lo que escribiste, no lo que quisiste decir. Negaciones, palabras de alcance ("solo", "cualquier") y condiciones implícitas se toman al pie de la letra. Si al revisar un error te encuentras explicando "lo que yo quería decir era…", esa explicación es la mitad que faltaba en la instrucción.
6. **Que un valor alto signifique "sí".** "¿El mensaje contiene datos personales?" es mejor que "¿Está libre de datos personales?".
7. **`instructions` y `criteria` deben ir alineados.** Si `true` significa "no", la pregunta rinde peor.
8. **Evita la indirección.** Dobles negaciones o "una propiedad de una propiedad" cuestan precisión. Reduce los saltos y apunta al campo exacto.
9. **Choice: da la lista completa** (hasta 255; cada opción cuesta pocos tokens) y agrega `other` / `none of the above` si la lista puede no cubrir todo. Usa `null` como descripción cuando el nombre basta: `{"calm": null, "angry": null}`.
10. **Score: describe situaciones, no grados.** "Feature roto pero existe workaround" le da al modelo algo contra qué comparar. "Moderadamente severo" no. Cada nivel se evalúa **por separado**: el modelo no ve el número del nivel ni sus vecinos, así que "peor que el anterior" no le dice nada. La prueba de la documentación: con `criteria: ["0","1","2"]` el mismo bug dio score 0.55 y confidence 0.33. Con niveles descriptivos dio 0.0 y confidence 1.0.
11. **Score: una dimensión por pregunta.** Si un caso extremo raro requiere otra acción (por ejemplo, "abusivo o amenazante"), dale su propio nivel.
12. **Noul: prueba con y sin `criteria`.** Casi siempre basta la instrucción. Cuando la frontera es sutil, agrega `true` y `false` con definición y ejemplos.
13. **Prueba afirmación vs. pregunta.** "The customer is requesting a refund" puede rendir distinto a "Is the customer requesting a refund?".

## 3.4 Pregunta todo junto (y especula)

- Todas las preguntas sobre el mismo state van **en un solo request**. Se evalúan en paralelo e independientes, sin contaminarse.
- **Fan-out especulativo:** pregunta también lo que *quizá* necesites. Por ejemplo, `return_reason` solo importa si `department == returns`. Si no aplica, tu código lo ignora. Es casi gratis.
- El cookbook de 13 preguntas regulatorias sobre GDPR mostró que batchear es **12.2× más barato y 10× más rápido** que 13 llamadas separadas, con las mismas respuestas.
- **Solo haz un segundo request cuando dependa de verdad del primero**, es decir, cuando necesites la primera respuesta para construir el state o las opciones de la siguiente. Ejemplos: re-evaluar el top-3 con el texto completo o recorrer una taxonomía nivel por nivel.

## 3.5 Confidence y umbrales

- `confidence` (solo en Choice y Score) resume **la forma** de la distribución: 1.0 si toda la probabilidad cae en una opción y baja conforme se reparte. Para 3 opciones se aproxima como `(3·pmax − 1)/2`, y en general como `(n·pmax − 1)/(n − 1)`.
- Si quieres otra métrica (entropía, margen top1–top2), calcúlala tú desde `probabilities`.
- Confidence baja en un Choice suele significar que ninguna opción gana claramente. También puede indicar que el ticket pertenece a dos equipos (en ese caso, notifica a ambos).
- Confidence baja en un Score suele significar niveles ambiguos, que la pregunta mide varias cosas o que el state no trae información suficiente.
- **Tres caminos:**
  - **Alta:** actuar automáticamente.
  - **Media:** actuar con cautela (pedir confirmación, marcar para revisión).
  - **Baja:** no actuar (humano, pedir aclaración, fallback a un LLM de razonamiento).
- **Los umbrales escalan con el riesgo.** Dentro del mismo sistema, `check_balance` puede actuar con 0.5 mientras `approve_transfer` exige más de 0.9 o confirmación del usuario.
- Umbral de un Noul: usa 0.5 si ambos errores cuestan lo mismo. **Súbelo** cuando un falso sí es caro (reembolsar, hacer page a alguien). **Bájalo** cuando un falso no es caro (no detectar un riesgo de seguridad). Los valores intermedios pueden ir a revisión humana: por ejemplo `NO=0.2`, `YES=0.8`, y entre ambos, a un humano.
- **No uses confidence en todos lados.** Si solo quieres la mejor opción, toma `choice`. Si tienes un algoritmo estadístico en mente, usa `probabilities`.
- **Calibra con tus datos.** Empieza conservador, mide y ajusta. Si fijaste umbrales, **fija también la versión del modelo**.

```python
action = r.answers["action"]
if action.confidence < 0.5:
    route_to_human(msg)                      # el modelo no está seguro: no adivines
elif action.choice == "check_balance":
    show_balance()                           # riesgo bajo
elif action.choice == "approve_transfer":
    confirm_then_execute() if action.confidence > 0.9 else ask_user_to_confirm()
```

## 3.6 Cómo leer un Score

- `score` es la **media ponderada** de los índices de nivel. 1.43 con `{1: 0.57, 2: 0.43}` indica una posición entre niveles. **No** es "el 43% de algo".
- Distribuciones distintas pueden dar el mismo score: 1.0 puede ser todo en el nivel 1, o mitad en el 0 y mitad en el 2. Mira también `probabilities` y `confidence`.
- Sirve para **rankear** o redondear al nivel más cercano. **No** sirve para interpolar magnitudes numéricas exactas, porque los niveles no están calibrados numéricamente.
- Para combinar varios Scores, normaliza con `score / (niveles − 1)` y luego pondera (ver *Composite scoring* en [04](./04-patrones-y-cookbooks.md)).

## 3.7 Estructura avanzada

`instructions`, las descripciones de opciones de Choice, los niveles de Score y `true`/`false` de Noul aceptan **JSON** (string, objeto, array o null).

**Choice con rúbrica de fronteras** (`what` / `not_for` / `examples`), que afina los bordes entre opciones:

```json
"criteria": {
  "billing": { "what": "Charges, invoices, refunds, or subscriptions",
               "not_for": "Order tracking or account access",
               "examples": ["I was charged twice", "Where is my refund?"] },
  "orders":  { "what": "Order status, delivery, cancellation, or returns",
               "not_for": "Charges or account access",
               "examples": ["Where is my package?", "Cancel my order"] }
}
```

**Instrucciones con datos**, por ejemplo para comparar contra un registro generado por código:

```json
"instructions": {
  "potential_duplicate": { "name": "John Smith", "location": "Oakland, California", "last_employer": "Google" },
  "question": "Is the resume for the same person as `potential_duplicate`?"
}
```

**Taxonomías profundas:** usa un Choice por nivel. El valor de cada opción es su subárbol, para que el modelo vea qué hay debajo antes de elegir. Luego recorres el árbol en código.

**Niveles de Score estructurados:** `{ "summary": "...", "signals": ["...", "..."] }`.

## 3.8 Failure modes conocidos de `jev-1.13` ("jaggedness")

| # | Falla | Qué hacer |
|---|---|---|
| 1 | Lectura literal | Escribe la condición exacta y pon los casos frontera en `criteria` |
| 2 | Matemáticas y conteo | Haz la aritmética en código. Para contar, **un Noul por ítem** y suma en código |
| 3 | Fechas (orden, rangos, duración) | Extrae componentes (mes, día y año, cada uno como un Choice con opción "not stated") y compara en código |
| 4 | Indirección | Menos saltos. Nombra el campo exacto |
| 5 | State grande con ruido | Filtra antes. Si no puedes, usa un Noul de relevancia primero |
| 6 | Contenido adversarial (prompt injection en el state) | Criteria explícitos y pruebas de casos borde. **El state es dato, no una instrucción confiable** |
| 7 | Instrucciones y criteria contradictorios | Alinéalos |
| 8 | Invariantes estructurales | No asumas que `P(sí) + P(no-sí) = 1` entre preguntas separadas (ejemplo real: 0.72 + 0.47 = 1.19). Un Noul y un Choice sí/no no son intercambiables y sus umbrales no se transfieren |
| 9 | Generación | No la fuerces encadenando Choices. Para extraer, deja que regex o un LLM propongan candidatos y que Jev elija |

Otras debilidades:

- Los valores numéricos como hex o RGB rinden peor que sus nombres semánticos. Convierte en código.
- El código de alto nivel lo entiende mejor que el assembly.
- **Choice vs. un Noul por opción:** el Choice es *relativo* (cuál de todas), mientras que cada Noul es *absoluto* y puede salir bajo para todas. Combina ambos cuando necesites decidir "cuál" **y** "si alguna".

## 3.9 Gotchas que reporta la comunidad

Fuentes en [05 §4](./05-casos-de-uso-comunidad.md#4-tips-y-gotchas-recurrentes).

- **Si falta la opción correcta, Jev elige otra con alta confianza.** Siempre incluye `none` o `other` y maneja esa rama.
- **Choice con muchas etiquetas:** el máximo es 255, pero varios ven degradación por encima de ~20. Considera Choices jerárquicos.
- **No hay multi-label nativo.** Una Noul por etiqueta funciona, pero las etiquetas vecinas tienden a dispararse juntas.
- **Para probabilidades de eventos, usa Noul y no Choice.** El Choice concentra la masa: en un dado justo eligió "1" con 0.83, y un riesgo de "30%" en el texto quedó en 5%.
- **"Tune the threshold, not the prompt."** Nueve variantes de prompt no movieron nada en el caso de Unblocked. Calibra el umbral con tus ejemplos, no uses 0.8 porque lo dice un README. El ruido es mayor justo cerca del umbral.
- **Instrucciones "como a un colega".** Agregar calificadores de "sé cuidadoso" empeoró la calibración (ECE de 0.040 a 0.116).
- **Varias Nouls objetivas combinadas en código** (todas deben pasar, media geométrica o regresión logística) suelen rendir mejor que un Score subjetivo directo.
- **Cachea decisiones:** son casi una función pura de (modelo, preguntas, state). Guarda inputs y outputs, que después te pueden servir para entrenar un modelo propio.
- **Evalúa bien:**
  - Compara contra el baseline de clase mayoritaria.
  - No uses como ground truth las etiquetas que generó tu sistema actual.
  - Separa los datos por familia y no al azar.
- **Bugs conocidos:**
  - `criteria: {"options": [...]}` en un Choice se acepta en silencio como una sola opción, con confidence 1.0.
  - NaN e Infinity se serializan como null.
  - Cloudflare puede devolver 403 si el state trae un `curl` con URL.

## 3.10 Checklist antes de producción

- [ ] Preguntas y umbrales en **un solo archivo** de constantes.
- [ ] Todo lo determinista (fechas, montos, regex, conteos) resuelto en código **antes** de llamar a Jev.
- [ ] State filtrado a lo que las preguntas necesitan.
- [ ] Todas las preguntas del mismo state en un request.
- [ ] Opción `other` en los Choices abiertos.
- [ ] Umbrales por nivel de riesgo, con zona gris que va a humano o a un LLM.
- [ ] **Shadow mode primero:** corre Jev en paralelo al sistema actual, loguea respuestas completas (probabilidades + `model` versionado), ajusta preguntas y umbrales con esos datos y automatiza primero el camino de bajo riesgo. Es el consejo de Flavio Copes y coincide con la documentación.
- [ ] Versión fijada (`jev-1.13.0`) si calibraste umbrales.
- [ ] Si el contenido está en español: mide la precisión con tus datos. El inglés es el idioma principal. Considera escribir `instructions` y `criteria` en inglés aunque el state esté en español (hipótesis para validar, no está documentado).
