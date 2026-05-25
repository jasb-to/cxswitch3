/**
 * EVENT EMITTER FOR SIGNALS
 * Decoupled signal events from cron
 */

type SignalEventHandler = (event: { symbol: string; state: string; signal: any }) => Promise<void>;

class SignalEventEmitter {
  private handlers: SignalEventHandler[] = [];

  subscribe(handler: SignalEventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler);
    };
  }

  async emit(event: { symbol: string; state: string; signal: any }): Promise<void> {
    await Promise.all(this.handlers.map(h => h(event).catch(err => console.error("[EMITTER]", err))));
  }
}

export const signalEvents = new SignalEventEmitter();
