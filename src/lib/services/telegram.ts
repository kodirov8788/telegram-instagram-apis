export interface TelegramWebhookMessage {
  update_id: number;
  message?: {
    message_id: number;
    from: {
      id: number;
      is_bot: boolean;
      first_name: string;
      last_name?: string;
      username?: string;
      language_code?: string;
    };
    chat: {
      id: number;
      type: string;
      title?: string;
      username?: string;
    };
    date: number;
    text?: string;
    caption?: string;
    photo?: any[];
    document?: any;
    voice?: any;
    location?: {
      latitude: number;
      longitude: number;
    };
    contact?: {
      phone_number: string;
      first_name: string;
      last_name?: string;
      user_id?: number;
    };
  };
  callback_query?: {
    id: string;
    from: any;
    message: any;
    data: string;
  };
}

export class TelegramService {
  private botToken: string;

  constructor(botToken: string, private readonly timeoutMs = 10_000) {
    this.botToken = botToken;
  }

  private get apiUrl() {
    return `https://api.telegram.org/bot${this.botToken}`;
  }

  async sendMessage(chatId: string | number, text: string, options?: { reply_markup?: any }) {
    const res = await fetch(`${this.apiUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: options?.reply_markup,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw TelegramProviderError.fromResponse(res, data);
    return data.result;
  }

  async sendPhoto(chatId: string | number, photoUrl: string, caption?: string) {
    const res = await fetch(`${this.apiUrl}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: 'HTML',
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw TelegramProviderError.fromResponse(res, data);
    return data.result;
  }
}

export class TelegramProviderError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'TelegramProviderError';
  }

  static fromResponse(response: Response, body: any) {
    const seconds = Number(response.headers.get('retry-after') ?? body?.parameters?.retry_after);
    const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
    const retryable = response.status === 429 || response.status >= 500;
    return new TelegramProviderError(`Telegram request failed (${response.status})`, retryable, retryAfterMs);
  }
}
