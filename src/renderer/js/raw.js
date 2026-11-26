/** Renderer-side client for the LibRaw worker. */

export class RawDecoder {
  constructor() {
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
  }

  ensure() {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('../workers/raw-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event) => {
      const msg = event.data || {};
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.ok) waiter.resolve(msg);
      else {
        const err = new Error(msg.error || 'RAW decode failed');
        err.code = msg.code;
        err.meta = msg.meta;
        waiter.reject(err);
      }
    };
    this.worker.onerror = (event) => {
      const err = new Error(event.message || 'RAW worker crashed');
      for (const [, waiter] of this.pending) waiter.reject(err);
      this.pending.clear();
    };
    return this.worker;
  }

  decode(arrayBuffer, { halfSize = true, force = false } = {}) {
    const worker = this.ensure();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const copy = arrayBuffer;
      try {
        worker.postMessage({ id, buffer: copy, options: { halfSize, force } }, [copy]);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    for (const [, waiter] of this.pending) waiter.reject(new Error('RAW decoder disposed'));
    this.pending.clear();
  }
}
