class TranscriptPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 24000;
    this.chunkSamples = 2400;
    this.buffer = new Int16Array(this.chunkSamples);
    this.writeIndex = 0;
    this.carry = 0;
    this.levelSumSquares = 0;
    this.levelCount = 0;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === "flush") {
        this.flush();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  flush() {
    if (this.writeIndex <= 0) return;
    const output = this.buffer.slice(0, this.writeIndex);
    const level =
      this.levelCount > 0
        ? Math.sqrt(this.levelSumSquares / this.levelCount)
        : 0;
    this.port.postMessage(
      { type: "pcm", buffer: output.buffer, level },
      [output.buffer],
    );
    this.buffer = new Int16Array(this.chunkSamples);
    this.writeIndex = 0;
    this.levelSumSquares = 0;
    this.levelCount = 0;
  }

  appendSample(sample) {
    const clamped = Math.max(-1, Math.min(1, sample || 0));
    this.levelSumSquares += clamped * clamped;
    this.levelCount += 1;
    this.buffer[this.writeIndex] = Math.max(
      -32768,
      Math.min(32767, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)),
    );
    this.writeIndex += 1;
    if (this.writeIndex >= this.buffer.length) {
      this.flush();
    }
  }

  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!channel || channel.length === 0) return true;

    const ratio = sampleRate / this.targetSampleRate;
    let position = this.carry;
    while (position < channel.length) {
      this.appendSample(channel[Math.floor(position)]);
      position += ratio;
    }
    this.carry = position - channel.length;
    return true;
  }
}

registerProcessor("transcript-pcm-processor", TranscriptPcmProcessor);
