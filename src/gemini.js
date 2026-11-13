// Minimal Gemini client (REST, no SDK). Supports function calling.
// Free-tier keys are rate limited, so transient errors are retried with backoff
// and everything else is turned into a message a human can act on.

export class AiError extends Error {
  constructor(message, { status = 502, code = 'AI_ERROR' } = {}) {
    super(message);
    this.name = 'AiError';
    this.status = status;
    this.code = code;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const backoff = (attempt) => Math.min(1000 * 2 ** attempt, 8000) + Math.floor(Math.random() * 250);

export class GeminiClient {
  constructor({
    apiKey,
    model = 'gemini-3-flash-preview',
    baseUrl = 'https://generativelanguage.googleapis.com/v1beta',
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    maxRetries = 3,
    timeoutMs = 45_000,
  }) {
    this.apiKey = apiKey;
    // "model" may be a comma separated list: the first is preferred, the rest are fallbacks
    // that are tried automatically when a model is slow, overloaded or unavailable.
    this.models = String(model).split(',').map((m) => m.trim()).filter(Boolean);
    if (!this.models.length) this.models = ['gemini-3-flash-preview'];
    this.model = this.models[0];
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @param {{systemInstruction?:string, contents:object[], functionDeclarations?:object[], toolMode?:string}} req
   * @returns {Promise<{content:object, parts:object[], text:string, functionCalls:{name:string,args:object}[], finishReason:string, model:string}>}
   */
  async generate({ systemInstruction, contents, functionDeclarations = [], toolMode = 'AUTO' }) {
    const body = { contents };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    if (functionDeclarations.length) {
      body.tools = [{ functionDeclarations }];
      body.toolConfig = { functionCallingConfig: { mode: toolMode } };
    }

    let lastError;
    for (let i = 0; i < this.models.length; i++) {
      try {
        return await this.#generateWith(this.models[i], body, this.models.length > 1);
      } catch (err) {
        lastError = err;
        const hasNext = i < this.models.length - 1;
        // A bad key will fail on every model, so do not bother trying the others.
        if (!hasNext || err?.code === 'AI_KEY') throw err;
        console.warn(`[gemini] model "${this.models[i]}" failed (${err.message}). Trying "${this.models[i + 1]}".`);
      }
    }
    throw lastError ?? new AiError('The AI request failed.', { status: 502 });
  }

  async #generateWith(model, body, hasFallback) {
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const last = attempt === this.maxRetries;
      let res;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError';
        // With a fallback model available, move on at once instead of waiting again.
        if (!last && !hasFallback) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new AiError(
          timedOut ? 'The AI service took too long to respond. Please try again.' : 'Could not reach the AI service. Check your internet connection.',
          { status: 503 }
        );
      }

      if (res.ok) return { ...parseResponse(await res.json()), model };

      const errBody = await res.json().catch(() => ({}));
      const apiMessage = errBody?.error?.message || `HTTP ${res.status}`;
      if (RETRYABLE.has(res.status) && !last && !(hasFallback && res.status === 429)) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : backoff(attempt));
        continue;
      }
      throw mapError(res.status, apiMessage, model);
    }
    throw new AiError('The AI request failed.', { status: 502 });
  }
}

function mapError(status, apiMessage, model) {
  if (status === 400 && /api key/i.test(apiMessage)) {
    return new AiError('The Gemini API key was rejected. Check GEMINI_API_KEY in your .env file.', { status: 502, code: 'AI_KEY' });
  }
  if (status === 401 || status === 403) {
    return new AiError('Gemini refused the request. Check that GEMINI_API_KEY is valid and the Gemini API is available for your account.', {
      status: 502,
      code: 'AI_KEY',
    });
  }
  if (status === 404) {
    return new AiError(`The Gemini model "${model}" was not found. Set GEMINI_MODEL in .env to a model your key can use (see README).`, {
      status: 502,
      code: 'AI_MODEL',
    });
  }
  if (status === 429) {
    return new AiError('The free Gemini quota is busy right now. Wait a few seconds and try again.', { status: 429, code: 'AI_RATE_LIMIT' });
  }
  if (status >= 500) {
    return new AiError('The AI service is temporarily unavailable. Please try again shortly.', { status: 503 });
  }
  return new AiError(`The AI request failed: ${apiMessage}`, { status: 502 });
}

function parseResponse(data) {
  const candidate = data?.candidates?.[0];
  if (!candidate) {
    const reason = data?.promptFeedback?.blockReason;
    throw new AiError(reason ? `The AI declined to answer (${reason}).` : 'The AI returned no answer.', { status: 502 });
  }
  // Keep the model's parts exactly as received: Gemini 3+ models require their
  // "thoughtSignature" fields to be sent back unchanged during function calling.
  const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
  const text = parts
    .filter((p) => typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('')
    .trim();
  const functionCalls = parts
    .filter((p) => p.functionCall)
    .map((p) => ({ name: p.functionCall.name, args: p.functionCall.args || {} }));
  return { content: { role: 'model', parts }, parts, text, functionCalls, finishReason: candidate.finishReason || '' };
}