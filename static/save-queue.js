/* One request at a time; keep the latest local snapshot until it is acknowledged. */
class SaveQueue {
  constructor(send, onState = () => {}) {
    this.send = send;
    this.onState = onState;
    this.revision = null;
    this.pending = null;
    this.running = false;
    this.error = null;
  }

  get dirty() { return this.running || this.pending !== null; }

  reset(revision) {
    if (this.running) throw new Error('保存中，请稍后重试');
    this.revision = revision;
    this.pending = null;
    this.error = null;
    this.onState(this);
  }

  enqueue(snapshot) {
    this.pending = JSON.parse(JSON.stringify(snapshot));
    this.onState(this);
    return this.flush();
  }

  retry() {
    if (this.error?.status === 409) return;
    this.error = null;
    return this.flush();
  }

  async flush() {
    if (this.running || this.error || !this.pending) return;
    this.running = true;
    this.onState(this);
    try {
      while (this.pending) {
        const snapshot = this.pending;
        this.pending = null;
        try {
          const saved = await this.send({ ...snapshot, revision: this.revision });
          this.revision = saved.revision;
        } catch (error) {
          this.pending = this.pending || snapshot;
          this.error = error;
          break;
        }
      }
    } finally {
      this.running = false;
      this.onState(this);
    }
  }
}

if (typeof module !== 'undefined') module.exports = { SaveQueue };
