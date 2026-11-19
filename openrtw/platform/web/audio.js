import { createPcmAudioOutput, PCM_AUDIO_OUTPUT_CAPABILITIES } from './runtime/pcm-audio-output.js';

// Rome's title adapter: core access, PCM admission/conversion and UI wording
// remain here; the generic runtime owns all Web Audio resources.
export function attachSound(core, button, status) {
  const frames = core._openrtw_pcm_frames(),
    rate = core._openrtw_pcm_rate(),
    pointer = core._openrtw_pcm_samples();
  if (!Number.isSafeInteger(frames) || frames < 1 ||
      frames > PCM_AUDIO_OUTPUT_CAPABILITIES.maxFrames || rate !== 22050 ||
      !Number.isSafeInteger(pointer) || pointer < 1)
    throw new Error('Marching sound is not loaded or exceeds its bounds');
  const heap = core.HEAPU8;
  if (!(heap instanceof Uint8Array) || pointer > heap.byteLength ||
      frames > Math.floor((heap.byteLength - pointer) / 2))
    throw new Error('Marching sound lies outside core memory');
  const bytes = new Uint8Array(heap.subarray(pointer, pointer + frames * 2)),
    view = new DataView(bytes.buffer);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = view.getInt16(i * 2, true) / 32768;

  let closed = false;
  let disposal = null;
  function finish(message, state) {
    button.disabled = closed;
    status.textContent = message;
    status.dataset.state = state;
  }
  const output = createPcmAudioOutput({
    samples,
    format: { precision: 'float32', channels: 1, layout: 'mono', sampleRate: rate },
    onStateChange(snapshot) {
      if (snapshot.state === 'playing') {
        button.disabled = true;
        status.textContent = 'Playing marching sound…';
        status.dataset.state = 'playing';
        status.dataset.contextRate = String(snapshot.contextSampleRate);
      } else if (snapshot.state === 'ended') {
        finish('Marching sound played', 'ended');
      } else if (snapshot.state === 'stopped') {
        finish('Marching sound ready', 'ready');
      } else if (snapshot.state === 'closed') {
        finish('Sound closed', 'closed');
      } else if (snapshot.state === 'error') {
        finish(String(snapshot.error), 'error');
      }
    },
  });
  status.textContent = 'Marching sound ready';
  status.dataset.state = 'ready';
  status.dataset.rate = String(rate);
  status.dataset.frames = String(frames);
  button.disabled = false;

  async function play() {
    if (closed) return;
    button.disabled = true;
    try {
      await output.play();
    } catch (error) {
      if (!closed) finish(String(error), 'error');
    }
  }
  button.addEventListener('click', play);
  return () => {
    if (disposal) return disposal;
    closed = true;
    button.disabled = true;
    button.removeEventListener('click', play);
    disposal = (async () => {
      try {
        await output.dispose();
      } catch (error) {
        finish(String(error), 'error');
        throw error;
      }
    })();
    return disposal;
  };
}
