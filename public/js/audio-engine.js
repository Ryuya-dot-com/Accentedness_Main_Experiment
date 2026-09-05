function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutAfter(ms, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function writeAscii(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (const sample of samples) {
    const clipped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export function analyzeSamples(samples, sampleRate, analysisStartSeconds = 0) {
  const startIndex = Math.max(0, Math.min(samples.length, Math.floor(analysisStartSeconds * sampleRate)));
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  const count = Math.max(1, samples.length - startIndex);
  for (let index = startIndex; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    const absolute = Math.abs(sample);
    sumSquares += sample * sample;
    if (absolute > peak) peak = absolute;
    if (absolute >= 0.98) clipped += 1;
  }
  return {
    analysis_start_seconds: analysisStartSeconds,
    analyzed_sample_count: count,
    rms_amplitude: Math.sqrt(sumSquares / count),
    peak_amplitude: peak,
    clipping_ratio: clipped / count,
  };
}

export class ExperimentAudio {
  constructor(api) {
    this.api = api;
    this.context = null;
    this.micStream = null;
    this.micTrack = null;
    this.worklet = null;
    this.capturePromise = null;
    this.processorError = null;
    this.captureFault = null;
  }

  async initialize({ microphone }) {
    if (!window.AudioContext || !window.AudioWorkletNode) {
      throw new Error("このブラウザは必要な音声機能に対応していません。Google Chromeを使用してください。");
    }
    if (!this.context) this.context = new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
    await this.context.resume();
    if (!microphone || this.worklet) return;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("マイク録音を利用できません。");
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    this.micTrack = this.micStream.getAudioTracks()[0];
    this.micTrack.addEventListener("ended", () => {
      this.processorError = new Error("マイク接続が終了しました。担当者に知らせてください。");
    });
    this.micTrack.addEventListener("mute", () => {
      if (this.capturePromise) this.captureFault = new Error("録音中にマイク入力が停止しました。");
    });
    await this.context.audioWorklet.addModule("/js/pcm-recorder-worklet.js");
    const source = this.context.createMediaStreamSource(this.micStream);
    this.worklet = new AudioWorkletNode(this.context, "pcm-recorder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.worklet.addEventListener("processorerror", () => {
      this.processorError = new Error("録音処理が停止しました。ページを再読み込みして再開してください。");
      if (this.capturePromise) this.captureFault = this.processorError;
    });
    const silent = this.context.createGain();
    silent.gain.value = 0;
    source.connect(this.worklet).connect(silent).connect(this.context.destination);
  }

  microphoneSettings() {
    if (!this.micTrack) return null;
    const settings = this.micTrack.getSettings();
    return {
      sample_rate: settings.sampleRate || this.context?.sampleRate || null,
      channel_count: settings.channelCount || 1,
      echo_cancellation: settings.echoCancellation ?? null,
      noise_suppression: settings.noiseSuppression ?? null,
      auto_gain_control: settings.autoGainControl ?? null,
    };
  }

  async loadCue(endpoint) {
    const blob = await this.api.fetchStimulus(endpoint);
    return this.context.decodeAudioData(await blob.arrayBuffer());
  }

  clockSnapshot() {
    const output = typeof this.context?.getOutputTimestamp === "function"
      ? this.context.getOutputTimestamp()
      : null;
    return {
      context_time_s: this.context?.currentTime ?? null,
      performance_time_ms: performance.now(),
      performance_time_origin_ms: performance.timeOrigin,
      output_context_time_s: output?.contextTime ?? null,
      output_performance_time_ms: output?.performanceTime ?? null,
      base_latency_s: this.context?.baseLatency ?? null,
      output_latency_s: this.context?.outputLatency ?? null,
    };
  }

  playCue(buffer, delaySeconds = 0, anchorContextS = null) {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    const anchor = Number.isFinite(anchorContextS) ? anchorContextS : this.context.currentTime;
    const scheduledStartContextS = Math.max(this.context.currentTime, anchor + delaySeconds);
    const scheduledEndContextS = scheduledStartContextS + buffer.duration;
    let endedPerfMs = null;
    const ended = new Promise((resolve, reject) => {
      source.onended = () => {
        endedPerfMs = performance.now();
        resolve({ endedPerfMs, endedContextS: this.context.currentTime });
      };
      try {
        source.start(scheduledStartContextS);
      } catch (error) {
        reject(error);
      }
    });
    return {
      scheduledStartContextS,
      scheduledEndContextS,
      durationS: buffer.duration,
      ended,
      stop: () => source.stop(),
    };
  }

  async startCapture() {
    if (!this.worklet) throw new Error("マイク録音が初期化されていません。");
    if (this.capturePromise) throw new Error("録音はすでに開始されています。");
    if (this.processorError) throw this.processorError;
    if (!this.micTrack || this.micTrack.readyState !== "live" || this.micTrack.muted) {
      throw new Error("マイク入力を確認できません。担当者に知らせてください。");
    }
    this.captureFault = null;
    let resolveStart;
    let rejectCapture;
    const started = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectCapture = reject;
    });
    const chunks = { startedFrame: null };
    const handler = (event) => {
      if (event.data?.type === "started") {
        chunks.startedFrame = event.data.frame;
        resolveStart(event.data.frame);
      }
      if (event.data?.type === "error") rejectCapture(new Error(event.data.message));
    };
    this.worklet.port.addEventListener("message", handler);
    this.worklet.port.start();
    const commandPerfMs = performance.now();
    this.worklet.port.postMessage({ type: "start" });
    let startedFrame;
    try {
      startedFrame = await Promise.race([
        started,
        timeoutAfter(3_000, "録音開始の確認がタイムアウトしました。"),
      ]);
    } catch (error) {
      this.worklet.port.postMessage({ type: "stop" });
      throw error;
    } finally {
      this.worklet.port.removeEventListener("message", handler);
    }
    this.capturePromise = { startedFrame, commandPerfMs };
    return {
      command_perf_ms: commandPerfMs,
      start_frame: startedFrame,
      start_context_s: startedFrame / this.context.sampleRate,
    };
  }

  async finishCapture({ analysisStartSeconds = 0, targetContextS = null } = {}) {
    if (!this.capturePromise) throw new Error("録音は開始されていません。");
    if (this.processorError) throw this.processorError;
    const start = this.capturePromise;
    const stopped = new Promise((resolve, reject) => {
      const handler = (event) => {
        if (event.data?.type !== "stopped") return;
        this.worklet.port.removeEventListener("message", handler);
        resolve(event.data);
      };
      this.worklet.port.addEventListener("message", handler);
      this.worklet.port.start();
      try {
        const targetFrame = Number.isFinite(targetContextS)
          ? Math.round(targetContextS * this.context.sampleRate)
          : null;
        this.worklet.port.postMessage({ type: "stop", targetFrame });
      } catch (error) {
        this.worklet.port.removeEventListener("message", handler);
        reject(error);
      }
    });
    const commandPerfMs = performance.now();
    const remainingMs = Number.isFinite(targetContextS)
      ? Math.max(0, (targetContextS - this.context.currentTime) * 1000)
      : 0;
    let result;
    try {
      result = await Promise.race([
        stopped,
        timeoutAfter(remainingMs + 5_000, "録音停止の確認がタイムアウトしました。"),
      ]);
    } finally {
      this.capturePromise = null;
    }
    const stoppedPerfMs = performance.now();
    const captureFault = this.captureFault ?? this.processorError;
    this.captureFault = null;
    if (captureFault) throw captureFault;
    if (!this.micTrack || this.micTrack.readyState !== "live" || this.micTrack.muted) {
      throw new Error("録音終了時にマイク入力を確認できませんでした。");
    }
    const samples = result.samples;
    const sampleRate = this.context.sampleRate;
    const durationSeconds = samples.length / sampleRate;
    const expectedSampleCount = Math.max(0, result.frame - start.startedFrame);
    const missingInputFrames = Number(result.missingInputFrames ?? 0);
    if (missingInputFrames !== 0 || samples.length !== expectedSampleCount) {
      throw new Error("録音中に音声frameの欠落を検出しました。ページを再読み込みして再開してください。");
    }
    return {
      blob: encodeWav(samples, sampleRate),
      samples,
      sample_rate_hz: sampleRate,
      sample_count: samples.length,
      duration_seconds: durationSeconds,
      command_stop_perf_ms: commandPerfMs,
      stopped_perf_ms: stoppedPerfMs,
      start_frame: start.startedFrame,
      stop_frame: result.frame,
      start_context_s: start.startedFrame / sampleRate,
      stop_context_s: result.frame / sampleRate,
      quality: analyzeSamples(samples, sampleRate, analysisStartSeconds),
      microphone_settings: this.microphoneSettings(),
      expected_sample_count: expectedSampleCount,
      sample_count_difference: samples.length - expectedSampleCount,
      missing_input_frames: missingInputFrames,
      scheduled_stop_context_s: targetContextS,
    };
  }

  stopCapture(analysisStartSeconds = 0) {
    return this.finishCapture({ analysisStartSeconds });
  }

  stopCaptureAt(targetContextS, analysisStartSeconds = 0) {
    return this.finishCapture({ analysisStartSeconds, targetContextS });
  }

  async microphoneCheck(durationMs = 2500) {
    const start = await this.startCapture();
    await delay(durationMs);
    const recording = await this.stopCapture(0);
    return { ...recording, capture_start: start };
  }

  async playBlob(blob) {
    const url = URL.createObjectURL(blob);
    try {
      const audio = new Audio(url);
      await audio.play();
      await new Promise((resolve, reject) => {
        audio.onended = resolve;
        audio.onerror = () => reject(new Error("録音を再生できませんでした。"));
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async playCalibrationTone() {
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.frequency.value = 440;
    gain.gain.setValueAtTime(0.0001, this.context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, this.context.currentTime + 0.03);
    gain.gain.setValueAtTime(0.08, this.context.currentTime + 0.42);
    gain.gain.exponentialRampToValueAtTime(0.0001, this.context.currentTime + 0.5);
    oscillator.connect(gain).connect(this.context.destination);
    const ended = new Promise((resolve) => { oscillator.onended = resolve; });
    oscillator.start();
    oscillator.stop(this.context.currentTime + 0.52);
    await ended;
  }

  close() {
    if (this.micStream) this.micStream.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") this.context.close();
    this.micStream = null;
    this.micTrack = null;
    this.worklet = null;
    this.context = null;
  }
}
