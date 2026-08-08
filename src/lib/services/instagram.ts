import { ProviderDeliveryError, fetchWithTimeout, parseRetryAfterMs } from './provider-delivery-error';

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

export interface InstagramSendResult {
  providerMessageId: string;
  raw: unknown;
}

/** Meta Graph API error subcodes/types that indicate a permanent, non-retryable condition. */
const PERMANENT_ERROR_CODES = new Set([190, 200, 10, 100]); // OAuthException, permission, invalid param family

export class InstagramService {
  private pageAccessToken: string;

  constructor(pageAccessToken: string) {
    this.pageAccessToken = pageAccessToken;
  }

  async sendDirectMessage(recipientId: string, text: string): Promise<InstagramSendResult> {
    const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${this.pageAccessToken}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    });

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      throw new ProviderDeliveryError('Instagram rate limited the request (429)', {
        retryable: true,
        retryAfterMs,
        statusCode: 429,
      });
    }

    if (res.status >= 500) {
      throw new ProviderDeliveryError(`Instagram server error (${res.status})`, { retryable: true, statusCode: res.status });
    }

    let data: any;
    try {
      data = await res.json();
    } catch (error) {
      throw new ProviderDeliveryError('Instagram response body was not valid JSON', {
        retryable: true,
        statusCode: res.status,
        cause: error,
      });
    }

    if (data.error) {
      const code = typeof data.error.code === 'number' ? data.error.code : res.status;
      const type = String(data.error.type ?? '');
      const permanent =
        PERMANENT_ERROR_CODES.has(code) ||
        type === 'OAuthException' ||
        (res.status >= 400 && res.status < 500 && res.status !== 429);
      console.error('Instagram Graph API error:', data.error);
      throw new ProviderDeliveryError(`Instagram error: ${data.error.message}`, {
        retryable: !permanent,
        statusCode: code,
      });
    }

    const providerMessageId = typeof data.message_id === 'string' ? data.message_id : undefined;
    if (!providerMessageId) {
      throw new ProviderDeliveryError('Instagram response missing message_id', { retryable: true, statusCode: res.status });
    }

    return { providerMessageId, raw: data };
  }
}
