/**
 * errors.ts — maps backend HTTP error responses to messages an agent can act
 * on, per #593's "clear, actionable error the model can act on" requirement.
 */

export class HazinaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'HazinaApiError';
  }
}

function extractServerMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    return typeof err === 'string' ? err : undefined;
  }
  return undefined;
}

/** Build a HazinaApiError with a status-specific, actionable message. */
export function mapApiError(status: number, body: unknown, context: string): HazinaApiError {
  const serverMessage = extractServerMessage(body);

  switch (status) {
    case 404:
      return new HazinaApiError(
        `${context}: dataset not found. Call search_datasets to find a valid id.`,
        status,
      );
    case 409:
      return new HazinaApiError(
        `${context}: conflict — this transaction hash was already used for a purchase. ` +
          `Each payment can only be redeemed once; initiate a new quote_purchase for another try.`,
        status,
      );
    case 429:
      return new HazinaApiError(
        `${context}: rate limited by the Hazina API. Wait a short while before retrying.`,
        status,
      );
    case 503:
      return new HazinaApiError(
        `${context}: this Hazina backend is not configured for that request right now ` +
          `(${serverMessage ?? 'service unavailable'}). Try demo mode or a different dataset.`,
        status,
      );
    case 400:
      return new HazinaApiError(
        `${context}: invalid request${serverMessage ? ` — ${serverMessage}` : ''}.`,
        status,
      );
    case 401:
    case 403:
      return new HazinaApiError(
        `${context}: not authorized. This server's HAZINA_API_KEY is missing or invalid — ` +
          `this is a configuration problem the operator needs to fix, not something the caller can retry around.`,
        status,
      );
    default:
      return new HazinaApiError(
        `${context}: request failed with status ${status}${serverMessage ? ` — ${serverMessage}` : ''}.`,
        status,
      );
  }
}
