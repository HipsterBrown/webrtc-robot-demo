import pako from 'pako';

export class Notifier extends EventTarget {
  server: string;
  defaultTopic: string;
  subscriptions: Map<string, ReadableStreamDefaultReader<string>>;

  constructor({ server = 'https://ntfy.sh', defaultTopic = 'wrtc' }) {
    super();
    this.server = server;
    this.defaultTopic = defaultTopic;
    this.subscriptions = new Map();
  }

  async subscribe(topic?: string) {
    topic ??= this.defaultTopic
    if (this.subscriptions.has(topic)) return;

    const response = await fetch(`${this.server}/${topic}/json`);
    const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();

    if (!reader) throw new Error(`Unable to subscribe to topic: ${topic}`)
    this.subscriptions.set(topic, reader);

    let done, value;
    while (!done) {
      ({ done, value } = await reader.read());
      if (done) {
        const closeEvent = new CustomEvent('close');
        this.dispatchEvent(closeEvent);
      } else {
        if (typeof value === 'undefined') return;
        try {
          const lines = value.split('\n').filter(Boolean);
          for (let line of lines) {
            const { event: eventName, ...detail } = JSON.parse(line);
            const notificationEvent = new CustomEvent(eventName, {
              detail,
            })
            this.dispatchEvent(notificationEvent);
          }
        } catch (error) {
          console.error('Parsing issue', { value: btoa(value), rawValue: value }, error)
        }
      }
    }
  }

  async publish(message: string, topic?: string) {
    topic ??= this.defaultTopic;

    const response = await fetch(`${this.server}/${topic}`, { body: message, method: 'POST' });
    return response.ok;
  }

  async cancel(topic: string) {
    topic ??= this.defaultTopic;

    if (this.subscriptions.has(topic)) {
      await this.subscriptions.get(topic)?.cancel();
      this.subscriptions.delete(topic);
    }

  }
}

export function prepareMessage(message: Record<string, unknown>): string {
  try {
    const jsonString = JSON.stringify(message);

    if (jsonString.length > 1000) {
      const compressed = pako.deflate(jsonString);

      return 'c:' + btoa(String.fromCharCode.apply(null, compressed));
    } else {
      return 'u:' + btoa(jsonString);
    }
  } catch (error) {
    console.error('Error compressing message:', error);
    return 'u:' + btoa(JSON.stringify(message));
  }
}

export function parseMessage(message: string): Record<string, unknown> {
  try {
    if (message.startsWith('c:')) {
      const base64Data = message.substring(2);

      const binary = atob(base64Data);

      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }

      const decompressed = pako.inflate(bytes);

      return JSON.parse(new TextDecoder().decode(decompressed));
    } else if (message.startsWith('u:')) {
      return JSON.parse(atob(message.substring(2)));
    } else {
      return JSON.parse(atob(message));
    }
  } catch (error) {
    console.error('Error parsing message:', error);
    throw error;
  }
}
