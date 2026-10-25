export const RECORDING_TARGET_RATE = 16_000;
export const RECORDING_MAX_SECONDS = 60;

const EMPTY_AUDIO = new Float32Array(0);

/**
 * Converts microphone audio (usually 44.1/48 kHz) to the 16 kHz mono stream
 * expected by whisper. Downsampling averages each output window, which acts as
 * a light anti-alias filter without pulling in a DSP dependency.
 */
export function resampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate <= 0 || input.length === 0) return EMPTY_AUDIO;
  if (inputRate === RECORDING_TARGET_RATE) return input;

  const ratio = inputRate / RECORDING_TARGET_RATE;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);

  if (ratio >= 1) {
    for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
      const start = Math.floor(outputIndex * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((outputIndex + 1) * ratio)));
      let sum = 0;
      for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
        sum += input[sourceIndex];
      }
      output[outputIndex] = sum / (end - start);
    }
    return output;
  }

  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const position = outputIndex * ratio;
    const left = Math.floor(position);
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    output[outputIndex] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

export function encodePcm16Wav(samples: Float32Array, sampleRate = RECORDING_TARGET_RATE): ArrayBuffer {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeText(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, Math.round(value), true);
    offset += 2;
  }

  return buffer;
}
