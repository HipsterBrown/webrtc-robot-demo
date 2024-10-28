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
