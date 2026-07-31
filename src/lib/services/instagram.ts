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

  constructor(pageAccessToken: string) {
    this.pageAccessToken = pageAccessToken;
  }

  async sendDirectMessage(recipientId: string, text: string) {
    const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${this.pageAccessToken}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    });

    const data = await res.json();
    if (data.error) {
      console.error('Instagram Graph API error:', data.error);
      throw new Error(`Instagram error: ${data.error.message}`);
    }
    return data;
  }
}
