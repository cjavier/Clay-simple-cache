# 6. Ideas: dónde encajaría Jev en Clay Cache API

> Estas son hipótesis de diseño para este repo (agencia GTM outbound), **no están implementadas ni medidas**. Siguen las reglas de [03](./03-disenar-preguntas.md): el código hace lo determinista y Jev hace solo juicios acotados, con umbral y zona gris.

Por qué vale la pena evaluarlo aquí:

- El proyecto ya tiene decisiones de alto volumen con espacio de respuesta cerrado: elegir el candidato correcto, clasificar y filtrar.
- A $0.042/MTok, un juicio de ~500 tokens cuesta **~$0.00002**. Un millón de decisiones cuesta ~$20, frente a centavos por llamada con `gpt-6-luna`.
- Aplica la misma disciplina que ya usa el finder: medir antes y después, loguear la evidencia y fallar cerrado.

## 6.1 LinkedIn Finder: elegir el candidato correcto de la SERP (candidato fuerte)

**Situación actual:** `src/services/linkedin-finder.service.ts` resuelve dominio → página de empresa con `match_type` = `domain_in_url` | `domain_in_snippet` | **`first_result`**. El último es un fallback ciego.

**Con Jev:** cuando no hay match determinista, se manda un Choice sobre los candidatos de Serper más una opción `none`, y un Noul por candidato ("¿esta página es la empresa dueña de `domain`?"). Es el patrón *skill suggestion* (Choice relativo + Nouls absolutos) y *entity alignment*.

```ts
import { TypeSafeClient, choice, noul } from "@typesafe-ai/sdk";

const state = {
  domain: "acme.com.mx",
  candidates: candidates.map((c, i) => ({ id: `c${i}`, url: c.url, title: c.title, snippet: c.snippet })),
};
const questions = {
  best: choice("Which of `candidates` is the LinkedIn company page of the company that owns `domain`?", {
    ...Object.fromEntries(state.candidates.map(c => [c.id, `${c.title} — ${c.url}`])),
    none: "None of the candidates is that company",
  }),
  ...Object.fromEntries(state.candidates.map((c, i) => [
    `is_${c.id}`, noul(`Is \`candidates[${i}]\` the LinkedIn page of the company that owns \`domain\`?`),
  ])),
};
// Regla: aceptar si best != none, best.confidence >= 0.7 y noul(best) >= 0.8. En cualquier otro caso, se reporta sin match. Nunca se usa el first_result a ciegas.
```

**Cómo medirlo:** toma los dominios donde hoy hay `domain_in_url` como ground truth, esconde esa señal y compara `first_result` contra Jev.

## 6.2 Profiles: de-duplicación y entity resolution

Pregunta: ¿dos registros (email distinto o LinkedIn distinto) son la misma persona?

- Usa un Noul con `instructions` estructuradas: `{ potential_duplicate: {...}, question: "Is \`profile\` the same person as \`potential_duplicate\`?" }`.
- Agrega Nouls de apoyo por campo que discrepa (nombre, empresa, ubicación), como en el cookbook de *entity alignment*.
- El código decide el merge. Jev solo opina en los casos ambiguos que las llaves normalizadas no resuelven.
- **Precedentes en la comunidad:**
  - Southbridge (donantes electorales): el código arma grupos candidatos y Jev decide. Cuesta 226x menos que un LLM y queda a 0.5 pp de precisión, pero **solo con Jev la precisión cae**, así que usan un LLM de revisión. Otra lección suya: el criterio vago de "hogar" falló 13/13, y reescrito como "misma dirección (número y calle) y personas distintas" acertó 13/13.
  - Vincenzo Iozzo (identidades Okta/AD/GitHub): una cuenta contra 20 candidatas por request, F1 0.95 y $0.62 por 1,000 cuentas.

## 6.3 `/explore` y `/copy`: guardrails y ruteo (cascade)

- **Guardrail de salida de `/copy`:** en un solo request, varios Nouls como "¿promete algo que el brief no respalda?", "¿contiene un dato inventado sobre el prospecto?" y "¿tono agresivo o spam-trigger?", más un Score de personalización. Se bloquea, se regenera o pasa según el umbral. Es el patrón *LLM guardrails*.
- **Ruteo de `/explore`:** clasificar la pregunta antes de lanzar el agente caro. Un Choice que distinga `lookup_en_cache` / `una_búsqueda` / `investigación_abierta` / `fuera_de_alcance` más un Score de complejidad. Es el patrón *intent routing* o *cascade*.
- **Filtro de páginas en `/explore`:** hacer un Noul de relevancia por página recuperada antes de meterla al contexto del LLM. Así el agente paga menos tokens y hay menos context rot. Es el patrón *classifying RAG passages*.

## 6.4 Enriquecimiento para campañas (ICP y triage)

- **Fit de ICP por empresa:** composite scoring con Scores de industria-fit, madurez digital (usa la salida del Tech Detector como state), tamaño y señales de dolor. Los pesos se definen por cliente y en código.
- **Triage de respuestas de campaña** (si se conecta con Smartlead o el inbox): un Choice `interesado / no ahora / no interesado / fuera de oficina / baja / referral` y un Noul "pide que no se le contacte", que se conecta directo con **DNC**. En este caso el costo de un falso negativo es alto, así que el umbral debe ir bajo y los dudosos a revisión. El mapa oficial de casos de uso menciona explícitamente "solicitudes de opt-out en flujos SDR". Hay repos de referencia de triage de email: `albertcas/jev-mail-filtering` y `az9713/jev-email-triage`.
- **Normalización de títulos de LinkedIn** a seniority y departamento: un Choice con opción `other`. Los títulos en español son un buen test de la debilidad multilingüe.

## 6.5 Dónde **no** usar Jev en este repo

- **Verificación de email, patrones y MX.** Son deterministas, o requieren una SMTP/API real. Jev no puede saber si un buzón existe.
- **Parseo de apellidos LATAM.** Ya está resuelto con reglas y datos medidos (79.6%). Como mucho, Jev podría desempatar casos raros con Choice sobre candidatos generados por código, y solo si se mide que gana.
- **Cualquier cálculo:** runway de créditos, conteos, fechas.

## 6.6 Cómo arrancar sin riesgo

1. Crear `src/services/jev.service.ts` con el cliente, las constantes de preguntas y umbrales en un solo lugar, y el timeout y los reintentos del SDK. Falla cerrado: si Jev no responde, se conserva el comportamiento actual.
2. **Shadow mode** en el LinkedIn Finder: calcular la respuesta de Jev y loguearla (probabilidades + `model`) sin cambiar el resultado.
3. Comparar contra ground truth con un script en `scripts/`, al estilo de los replays del finder.
4. Activar primero el camino de alta confianza, con la versión fijada en `jev-1.13.0`.
