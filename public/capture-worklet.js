// Keep this file dependency-free: it runs in the AudioWorklet global scope.
class Paper2Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.used = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data !== 'flush' || this.stopped) return;
      this.stopped = true;
      this.send();
      this.port.postMessage({ flushed: true });
    };
  }

  send() {
    if (!this.used) return;
    const samples = this.buffer.slice(0, this.used);
    this.port.postMessage({ samples }, [samples.buffer]);
    this.used = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i += 1) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      this.buffer[this.used++] = sample / channels.length;
      if (this.used === this.buffer.length) this.send();
    }
    return true;
  }
}

registerProcessor('paper2-capture', Paper2Capture);
