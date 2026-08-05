export interface InstagramWebhookEvent {
  object: string;
  entry: Array<{
    id: string;
    time: number;
    messaging?: Array<{
      sender: { id: string };
      recipient: { id: string };
      timestamp: number;
      message?: {
        mid: string;
        text?: string;
        attachments?: Array<{
          type: string;
          payload: { url: string };
        }>;
      };
      postback?: {
        title: string;
        payload: string;
      };
    }>;
  }>;
}

export class InstagramService {
  private pageAccessToken: string;

  constructor(pageAccessToken: string, private readonly timeoutMs = 10_000) {
    this.pageAccessToken = pageAccessToken;
  }

  async sendDirectMessage(recipientId: string, text: string) {
    const url = 'https://graph.facebook.com/v19.0/me/messages';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.pageAccessToken}` },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw InstagramProviderError.fromResponse(res, data);
    return data;
  }
}

export class InstagramProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'InstagramProviderError';
  }

  static fromResponse(response: Response, body: any) {
    const seconds = Number(response.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
    const code = Number(body?.error?.code);
    const retryable = response.status === 429 || response.status >= 500 || [1, 2, 4, 17, 32, 613].includes(code);
    return new InstagramProviderError(`Instagram request failed (${response.status})`, retryable, retryAfterMs);
  }
}
