class Paper2Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.offset = 0;
    this.accepting = true;
    this.port.onmessage = ({ data }) => {
      if (data !== 'flush') return;
      this.accepting = false;
      if (this.offset) {
        const samples = this.buffer.slice(0, this.offset);
        this.port.postMessage({ samples }, [samples.buffer]);
        this.offset = 0;
      }
      this.port.postMessage({ flushed: true });
    };
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!this.accepting || !channel) return true;
    let index = 0;
    while (index < channel.length) {
      const count = Math.min(channel.length - index, this.buffer.length - this.offset);
      this.buffer.set(channel.subarray(index, index + count), this.offset);
      this.offset += count;
      index += count;
      if (this.offset === this.buffer.length) {
        this.port.postMessage({ samples: this.buffer }, [this.buffer.buffer]);
        this.buffer = new Float32Array(4096);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('paper2-capture', Paper2Capture);
