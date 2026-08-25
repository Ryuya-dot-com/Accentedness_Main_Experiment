class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.chunks = [];
    this.stopAtFrame = null;
    this.missingInputFrames = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === "start") {
        this.chunks = [];
        this.stopAtFrame = null;
        this.missingInputFrames = 0;
        this.recording = true;
        this.port.postMessage({ type: "started", frame: currentFrame });
      }
      if (event.data?.type === "stop") {
        const requestedFrame = Number(event.data.targetFrame);
        if (Number.isFinite(requestedFrame) && requestedFrame > currentFrame) {
          this.stopAtFrame = Math.floor(requestedFrame);
        } else {
          this.finish(currentFrame);
        }
      }
    };
  }

  finish(frame) {
    if (!this.recording) return;
    this.recording = false;
    this.stopAtFrame = null;
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(length);
    let offset = 0;
    this.chunks.forEach((chunk) => {
      samples.set(chunk, offset);
      offset += chunk.length;
    });
    this.chunks = [];
    this.port.postMessage({
      type: "stopped",
      frame,
      missingInputFrames: this.missingInputFrames,
      samples,
    }, [samples.buffer]);
  }

  process(inputs, outputs) {
    if (this.recording) {
      const channel = inputs[0]?.[0];
      const quantumLength = channel?.length ?? outputs[0]?.[0]?.length ?? 128;
      const availableFrames = this.stopAtFrame === null
        ? quantumLength
        : Math.max(0, Math.min(quantumLength, this.stopAtFrame - currentFrame));
      if (availableFrames > 0) {
        if (channel) {
          this.chunks.push(new Float32Array(channel.subarray(0, availableFrames)));
        } else {
          this.chunks.push(new Float32Array(availableFrames));
          this.missingInputFrames += availableFrames;
        }
      }
      if (this.stopAtFrame !== null && currentFrame + quantumLength >= this.stopAtFrame) {
        this.finish(currentFrame + availableFrames);
      }
    }
    return true;
  }
}

registerProcessor("pcm-recorder", PcmRecorderProcessor);
