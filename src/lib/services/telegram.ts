import { ProviderDeliveryError, fetchWithTimeout, parseRetryAfterMs } from './provider-delivery-error';

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

export interface TelegramSendResult {
  providerMessageId: string;
  raw: unknown;
}

/** Telegram error_code values that indicate a permanent, non-retryable condition (bad/revoked credential, blocked, etc). */
const PERMANENT_ERROR_CODES = new Set([401, 403]);

export class TelegramService {
  private botToken: string;

  constructor(botToken: string) {
    this.botToken = botToken;
  }

  private get apiUrl() {
    return `https://api.telegram.org/bot${this.botToken}`;
  }

  async sendMessage(chatId: string | number, text: string, options?: { reply_markup?: any }): Promise<TelegramSendResult> {
    const res = await fetchWithTimeout(`${this.apiUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: options?.reply_markup,
      }),
    });

    return this.handleResponse(res);
  }

  async sendPhoto(chatId: string | number, photoUrl: string, caption?: string): Promise<TelegramSendResult> {
    const res = await fetchWithTimeout(`${this.apiUrl}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
        parse_mode: 'HTML',
      }),
    });
    return this.handleResponse(res);
  }

  private async handleResponse(res: Response): Promise<TelegramSendResult> {
    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('retry-after');
      let retryAfterMs = parseRetryAfterMs(retryAfterHeader);
      // Telegram also echoes retry_after (seconds) in the JSON body.
      if (retryAfterMs === undefined) {
        try {
          const body = await res.json();
          if (typeof body?.parameters?.retry_after === 'number') {
            retryAfterMs = body.parameters.retry_after * 1_000;
          }
        } catch {
          /* fall through with no retryAfterMs */
        }
      }
      throw new ProviderDeliveryError('Telegram rate limited the request (429)', {
        retryable: true,
        retryAfterMs,
        statusCode: 429,
      });
    }

    if (res.status >= 500) {
      throw new ProviderDeliveryError(`Telegram server error (${res.status})`, { retryable: true, statusCode: res.status });
    }

    let data: any;
    try {
      data = await res.json();
    } catch (error) {
      throw new ProviderDeliveryError('Telegram response body was not valid JSON', {
        retryable: true,
        statusCode: res.status,
        cause: error,
      });
    }

    if (!data.ok) {
      const errorCode = typeof data.error_code === 'number' ? data.error_code : res.status;
      const permanent = PERMANENT_ERROR_CODES.has(errorCode) || (errorCode >= 400 && errorCode < 500 && errorCode !== 429);
      console.error('Telegram API error:', data);
      throw new ProviderDeliveryError(`Telegram error: ${data.description}`, {
        retryable: !permanent,
        statusCode: errorCode,
      });
    }

    const providerMessageId = data.result?.message_id != null ? String(data.result.message_id) : undefined;
    if (!providerMessageId) {
      throw new ProviderDeliveryError('Telegram response missing message_id', { retryable: true, statusCode: res.status });
    }

    return { providerMessageId, raw: data.result };
  }
}
