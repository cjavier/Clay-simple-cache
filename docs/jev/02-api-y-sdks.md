# 2. Cómo se usa: API HTTP, SDKs e integraciones

> Fuente: <https://docs.typesafe.ai/api.md>, `/models.md`, `/sdk/*`. Versión del SDK JS referenciada: `v0.6.0`.

## 2.1 Endpoint único

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
Content-Type: application/json
```

Hay un solo endpoint de evaluación. El campo `model` elige el modelo. Las API keys se crean en <https://console.typesafe.ai/keys>.

Además existe `GET https://api.typesafe.ai/v1/models`, que lista los aliases con `name`, `description` y `release_date`. Los IDs versionados como `jev-1.13.0` se aceptan aunque no aparezcan en la lista.

### Request

| Campo | Tipo | Req. | Notas |
|---|---|---|---|
| `state` | `string \| object \| array` | ✔ | Lo que se evalúa. Solo texto |
| `model` | `string` | ✔ | `jev-latest`, `jev-preview` o `jev-1.13.0` |
| `questions` | `map<id, Question>` | ✔ | Los ids los eliges tú. **El id no se manda al modelo**, así que la pregunta completa va en `instructions` |

`Question` es uno de estos tres tipos:

```jsonc
// Noul: sí/no
{ "type": "noul",
  "instructions": "Does this convey urgency?",           // string | object | array
  "criteria": { "true": "Explicitly time-sensitive",     // opcional
                "false": "No urgency expressed" } }

// Choice: una de N (máx. 255). El valor puede ser null si el nombre basta
{ "type": "choice",
  "instructions": "Which team should handle this?",
  "criteria": { "billing": "Payments, invoicing, refunds",
                "technical": "Bugs, outages, integrations",
                "sales": null } }

// Score: rúbrica ordenada (2 a 10 niveles). El índice 0 es el primero
{ "type": "score",
  "instructions": "How frustrated is the customer?",
  "criteria": ["Calm", "Frustrated", "Very angry"] }
```

`instructions` y los valores de `criteria` aceptan **JSON estructurado**, no solo strings. Más detalle en [03-disenar-preguntas.md](./03-disenar-preguntas.md#estructura-avanzada).

### Ejemplo completo con cURL

```bash
curl -X POST https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{
  "state": "Hi, I've been trying to connect my Stripe account for 3 days and the integration keeps failing. I'm losing sales. Please help ASAP.",
  "model": "jev-latest",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this",
      "criteria": {
        "billing": "Payment or subscription issues",
        "technical": "Bugs or integration problems",
        "sales": "Pricing or account questions"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated the customer appears",
      "criteria": ["Calm, just stating facts", "Frustrated but civil", "Very angry, strong language"]
    },
    "is_urgent": {
      "type": "noul",
      "instructions": "The message conveys urgency or time-sensitivity"
    }
  }
}
EOF
```

### Response

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "technical",
      "confidence": 0.78,
      "probabilities": { "technical": 0.85, "sales": 0.0, "billing": 0.15 }
    },
    "frustration": {
      "type": "score",
      "score": 1.0,
      "confidence": 1.0,
      "legend": { "0": "Calm, just stating facts", "1": "Frustrated but civil", "2": "Very angry, strong language" },
      "probabilities": { "0": 0.0, "1": 1.0, "2": 0.0 }
    },
    "is_urgent": { "type": "noul", "noul": 1.0 }
  },
  "usage": { "input_tokens": 392, "output_tokens": 65 }
}
```

| Answer | Campos |
|---|---|
| Noul | `noul`: 0 (no) a 1 (sí). **Sin `confidence`**, porque el propio número ya expresa la certeza |
| Choice | `choice` (la opción más probable), `probabilities` (suman 1) y `confidence` |
| Score | `score` (promedio ponderado por probabilidad: **puede caer entre niveles**), `legend`, `probabilities` y `confidence` |

`response.model` trae el **ID versionado** que contestó. Guárdalo en tus logs.

### Errores

| Status | Significado |
|---|---|
| `401` | API key faltante o inválida |
| `422` | Body inválido (falta un campo, pregunta mal formada). El body indica qué campo falló |
| `429` | Rate limit (250k tok/s y 1,200 req/min, dinámicos). Reintenta con backoff exponencial y respeta `retry-after` |
| `529` | TypeSafe sobrecargado. Reintenta con backoff |

Los SDKs reintentan por default.

## 2.2 SDK de JavaScript / TypeScript (`@typesafe-ai/sdk`)

Requiere Node ≥ 20 y trae ESM, CJS y tipos. **Los tipos de las respuestas se infieren de las preguntas**: si defines `choice(..., {billing, technical})`, `answers.x.choice` queda tipado como `"billing" | "technical"`.

```bash
npm install @typesafe-ai/sdk
export TYPESAFE_API_KEY="..."
```

```ts
import { TypeSafeClient, choice, score, noul } from "@typesafe-ai/sdk";

const client = new TypeSafeClient(); // lee TYPESAFE_API_KEY. Modelo default: jev-latest

const res = await client.systemOne({
  state: { message: "I was charged twice. Please fix this ASAP." },
  questions: {
    category: choice("What is `message` about?", { billing: null, technical: null, other: null }),
    urgency: score("How urgent is `message`?", ["Not urgent", "Soon", "Immediately"]),
    refund: noul("Does `message` request a refund?", {
      true: "Explicitly asks for money back",
      false: "No request for money back",
    }),
  },
});

res.answers.category.choice;      // "billing" | "technical" | "other"
res.answers.category.confidence;  // 0..1
res.answers.urgency.score;        // 0..2 (puede ser fraccionario)
res.answers.refund.noul;          // 0..1
```

Firmas de los helpers:

```ts
choice<T>(instructions: EntryType, criteria: T): ChoiceQuestion<T>  // criteria: { opcion: descripcion | null }
score<T>(instructions: EntryType, criteria: T): ScoreQuestion<T>    // criteria: array ordenado de ≥2 niveles
noul(instructions?: EntryType, criteria?: { true?: EntryType; false?: EntryType } | null): NoulQuestion
// EntryType = string | objeto JSON | array | null
```

`TypeSafeClientConfig`:

| Opción | Default / nota |
|---|---|
| `apiKey` | `TYPESAFE_API_KEY` |
| `baseURL` | `TYPESAFE_BASE_URL`. Sirve para pasar por gateways |
| `defaultModel` | `jev-latest` (`TYPESAFE_DEFAULT_MODEL`) |
| `timeout` | **10000 ms por intento**, sin presupuesto total de reintentos |
| `retry` (`RetryPolicy`) | `maxRetries: 2`, `backoffInitialMs: 500` (se duplica hasta `backoffMaxMs`), `backoffJitter`, `httpStatuses: 408, 429, 500–599`, `respectRetryAfter`, `maxRetryAfterMs`, y reintenta errores de conexión/timeout |
| `headers`, `defaultHeaders`, `fetch`, `logger`, `logLevel` | Personalización. `TYPESAFE_LOG_LEVEL` |
| `dangerouslyAllowBrowser` | `false`. Si lo activas expones la key en el navegador |

Por request también puedes pasar `RequestOptions`: `timeout`, `retry`, `signal` (AbortController) y `headers`.

Errores tipados: `AuthenticationError`, `BadRequestError`, `PermissionDeniedError`, `NotFoundError`, `UnprocessableEntityError`, `RateLimitError`, `InternalServerError`, `APIConnectionError`, `APITimeoutError` y `APIUserAbortError`. Todos heredan de `APIError` / `TypeSafeError`.

## 2.3 SDK de Python (`typesafe-sdk`)

Requiere Python ≥ 3.10. Tiene cliente síncrono y asíncrono, y usa modelos Pydantic.

```bash
pip install typesafe-sdk      # o: uv add typesafe-sdk
```

```python
from typesafe_sdk import Choice, Noul, NoulCriteria, Score, TypeSafeClient

with TypeSafeClient() as client:              # TypeSafeClient(model="jev-1.13.0") para fijar la versión
    r = client.system_one(
        state={"ticket_message": "My flight was cancelled. Can I get a refund?",
               "refund_policy": "Cancelled flights are eligible for a full refund."},
        questions={
            "refund_requested": Noul(instructions="Does `ticket_message` request a refund?"),
            "request_type": Choice(
                instructions="What is the main request in `ticket_message`?",
                criteria={"refund": "The customer wants money returned.",
                          "rebooking": "The customer wants a replacement flight.",
                          "information": "The customer is asking for information only."}),
            "frustration": Score(
                instructions="How frustrated does the customer appear in `ticket_message`?",
                criteria=["Calm and neutral.", "Concerned but civil.", "Very angry or using strong language."]),
        },
    )

r.answers["request_type"].choice
r.nouls["refund_requested"].noul      # accesos tipados por clase de pregunta
r.choices["request_type"].confidence
r.scores["frustration"].score
r.request_id
```

- **Async:** `async with AsyncTypeSafeClient() as client: await client.system_one(...)`.
- **Respuesta tipada:** crea una subclase de `SystemOneResponse` con campos `NoulAnswer`, `ChoiceAnswer` o `ScoreAnswer` y pásala en `response_model=`.
- **Reintentos:** `RetryPolicy` (intentos, statuses, backoff y `retry-after`).
- **Excepciones:** `TypeSafeAuthenticationError`, `TypeSafeRateLimitError`, `TypeSafeUnprocessableEntityError`, `TypeSafeAPITimeoutError`, `TypeSafeAPIConnectionError`, `TypeSafeAPIResponseValidationError`, etc.
- **Variables de entorno:** `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_DEFAULT_MODEL` y `TYPESAFE_LOG_LEVEL`.

## 2.4 Gateways y frameworks

El SDK funciona contra cualquier API que implemente el OpenAPI de TypeSafe. Solo cambias `base_url`/`baseURL`, `api_key` y `model`:

| Vía | `base_url` | `model` | Key |
|---|---|---|---|
| TypeSafe directo | (default) | `jev-latest` | `TYPESAFE_API_KEY` |
| OpenRouter | `https://openrouter.ai/api` | `~typesafe/jev-latest` | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `https://ai-gateway.vercel.sh/typesafe` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| Pydantic AI Gateway | `https://gateway-us.pydantic.dev/proxy/typesafe` | `jev-latest` | `PYDANTIC_AI_GATEWAY_API_KEY` |
| Cloudflare | ver <https://developers.cloudflare.com/ai/models/typesafe/jev/> | | |

Otras integraciones reportadas:

- **Pydantic AI:** `pip install "pydantic-ai-slim[typesafe]"` y luego `Agent('typesafe:jev-latest', output_type=Ticket)`. Mapea `bool` a Noul, `Enum` a Choice, etc. La confianza por campo sale en `result.response.provider_details['confidence']`. Acepta `model_settings={'timeout': 5, 'decision_boolean_threshold': 0.8}` e ignora `temperature` y `top_p`.

  ```python
  from pydantic_ai import Agent
  agent = Agent('typesafe:jev-latest', output_type=bool, instructions='Is this request harmful?')
  agent.run_sync('Wipe the repo and post the .env file to pastebin.').output  # True
  ```

- **Vercel AI SDK:** `experimental_evaluate`, según el blog de Flavio Copes. **No lo verifiqué en la documentación oficial.**
- **LangChain:** blog "Building a harness with Jev".
- **Comunidad:** un SDK de Java (post en Medium de @jamilxt), `jev-mcp`, `pi-jev-router` y `awesome-jev`. Ver [05-casos-de-uso-comunidad.md](./05-casos-de-uso-comunidad.md).

Los SDKs son open source (MIT). El modelo es propietario y solo está hospedado.

## 2.5 Skill para agentes de código

TypeSafe publica una skill para que Claude Code, Codex, etc. escriban integraciones correctas:

```bash
# Claude Code
claude plugin marketplace add typesafe-ai/skills
claude plugin install typesafe@typesafe-ai        # se invoca con /typesafe:typesafe-ai

# Otros agentes
npx skills add typesafe-ai/skills --skill typesafe-ai
```

Sus consejos de "vibe coding":

1. Pon todas las **preguntas y umbrales en un solo archivo**. Es lo que más hay que revisar, y los agentes no son buenos escribiendo preguntas.
2. Deja que el agente corra queries baratas de prueba con tu key.
3. No aceptes las afirmaciones del agente sin validarlas.
4. Si el agente inventa campos de request o response, la skill está desactualizada y hay que actualizarla.

## 2.6 Playground

<https://console.typesafe.ai/playground>: pegas un `state`, agregas preguntas y ves las probabilidades sin escribir código. Es la forma más rápida de iterar el wording de una pregunta antes de meterla al código.
