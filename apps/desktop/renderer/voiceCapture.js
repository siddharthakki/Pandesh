/** Push-to-talk, VAD utterance, and wake-word PCM helpers — renderer only. */
(function attachVoiceCapture(global) {
  const MAX_UTTERANCE_MS = 45_000;
  const TARGET_RATE = 16_000;
  const WAKE_FRAME = 1280; // 80 ms @ 16 kHz — openWakeWord streaming frame
  const VAD_SILENCE_MS = 900;
  const VAD_MIN_SPEECH_MS = 400;
  const VAD_SPEECH_RMS = 0.015;
  const VAD_SILENCE_RMS = 0.008;

  function encodeWavFromAudioBuffer(audioBuffer) {
    const numChannels = 1;
    const sampleRate = audioBuffer.sampleRate;
    const samples = audioBuffer.getChannelData(0);
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = samples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset, value) {
      for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
    }

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
    return new Uint8Array(buffer);
  }

  async function blobToMonoWav(blob) {
    const audioContext = new AudioContext();
    try {
      const arrayBuffer = await blob.arrayBuffer();
      const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
      const mono = audioContext.createBuffer(1, decoded.length, decoded.sampleRate);
      const channel = mono.getChannelData(0);
      for (let ch = 0; ch < decoded.numberOfChannels; ch += 1) {
        const source = decoded.getChannelData(ch);
        for (let i = 0; i < source.length; i += 1) channel[i] += source[i] / decoded.numberOfChannels;
      }
      const atTarget = resampleFloat32(channel, mono.sampleRate, TARGET_RATE);
      const out = audioContext.createBuffer(1, atTarget.length, TARGET_RATE);
      out.copyToChannel(atTarget, 0);
      return encodeWavFromAudioBuffer(out);
    } finally {
      await audioContext.close().catch(() => undefined);
    }
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      const slice = bytes.subarray(i, i + chunk);
      binary += String.fromCharCode(...slice);
    }
    return btoa(binary);
  }

  function floatToInt16(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i += 1) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function rms(float32) {
    if (!float32.length) return 0;
    let sum = 0;
    for (let i = 0; i < float32.length; i += 1) sum += float32[i] * float32[i];
    return Math.sqrt(sum / float32.length);
  }

  /**
   * Resample. Browsers often ignore AudioContext({ sampleRate: 16000 }) and run
   * at the device rate (commonly 48000); openWakeWord and Whisper need 16 kHz.
   * Downsampling averages each output sample's source span (a box low-pass), so
   * content above the new Nyquist (hiss, fricatives, mains hum) is not folded
   * back into the speech band as noise. Upsampling interpolates linearly.
   */
  function resampleFloat32(input, fromRate, toRate) {
    if (!input?.length) return new Float32Array(0);
    if (!fromRate || !toRate || fromRate === toRate) {
      return input instanceof Float32Array ? input : Float32Array.from(input);
    }
    const ratio = fromRate / toRate;
    const outLen = Math.max(0, Math.floor(input.length / ratio));
    const out = new Float32Array(outLen);
    if (ratio > 1) {
      for (let i = 0; i < outLen; i += 1) {
        const start = Math.floor(i * ratio);
        const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
        let sum = 0;
        for (let k = start; k < end; k += 1) sum += input[k];
        out[i] = sum / (end - start);
      }
      return out;
    }
    for (let i = 0; i < outLen; i += 1) {
      const srcIndex = i * ratio;
      const i0 = Math.floor(srcIndex);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const t = srcIndex - i0;
      out[i] = input[i0] * (1 - t) + input[i1] * t;
    }
    return out;
  }

  async function getMicStream(opts = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone API unavailable in this host (navigator.mediaDevices.getUserMedia missing).');
    }
    const wake = Boolean(opts.forWake);
    return navigator.mediaDevices.getUserMedia({
      audio: {
        // Wake: prefer raw-ish input; AEC/NS/AGC can wipe or pump the phrase.
        echoCancellation: wake ? false : true,
        noiseSuppression: wake ? false : true,
        autoGainControl: wake ? false : true,
        channelCount: 1,
      },
      video: false,
    });
  }

  function startPushToTalkCapture() {
    let recorder = null;
    let stream = null;
    const chunks = [];
    let stopped = false;
    let stopResolve = null;
    const done = new Promise((resolve) => {
      stopResolve = resolve;
    });
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      recorder = null;
    };

    const finish = async () => {
      if (stopped) return;
      stopped = true;
      cleanup();
      if (chunks.length === 0) {
        stopResolve(null);
        return;
      }
      try {
        const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
        const wav = await blobToMonoWav(blob);
        stopResolve(wav);
      } catch (err) {
        stopResolve(Promise.reject(err));
      }
    };

    void (async () => {
      try {
        stream = await getMicStream({ forWake: false });
        recorder = new MediaRecorder(stream);
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data?.size) chunks.push(event.data);
        });
        recorder.addEventListener('stop', () => {
          void finish();
        });
        recorder.start();
        timeoutId = setTimeout(() => {
          if (recorder?.state === 'recording') recorder.stop();
        }, MAX_UTTERANCE_MS);
      } catch (err) {
        cleanup();
        stopResolve(Promise.reject(err instanceof Error ? err : new Error(String(err))));
      }
    })();

    return {
      stop: () => {
        if (stopped) return done;
        if (recorder && recorder.state === 'recording') recorder.stop();
        else void finish();
        return done;
      },
      cancel: () => {
        if (stopped) return;
        stopped = true;
        chunks.length = 0;
        if (recorder && recorder.state === 'recording') recorder.stop();
        cleanup();
        stopResolve(null);
      },
    };
  }

  function startVadUtteranceCapture(opts = {}) {
    const onState = typeof opts.onState === 'function' ? opts.onState : () => undefined;
    let stream = null;
    let audioContext = null;
    let processor = null;
    let source = null;
    let stopped = false;
    let stopResolve = null;
    const done = new Promise((resolve) => {
      stopResolve = resolve;
    });
    const samples = [];
    let speechStartedAt = 0;
    let lastSpeechAt = 0;
    let timeoutId = null;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      try { processor?.disconnect(); } catch { /* ignore */ }
      try { source?.disconnect(); } catch { /* ignore */ }
      try { void audioContext?.close(); } catch { /* ignore */ }
      stream?.getTracks().forEach((track) => track.stop());
      processor = null;
      source = null;
      audioContext = null;
      stream = null;
    };

    const finish = (wavBytes) => {
      if (stopped) return;
      stopped = true;
      cleanup();
      stopResolve(wavBytes);
    };

    void (async () => {
      try {
        stream = await getMicStream({ forWake: false });
        audioContext = new AudioContext({ sampleRate: TARGET_RATE });
        if (audioContext.state === 'suspended') await audioContext.resume();
        source = audioContext.createMediaStreamSource(stream);
        processor = audioContext.createScriptProcessor(4096, 1, 1);
        onState('capturing');
        processor.onaudioprocess = (event) => {
          if (stopped) return;
          const input = event.inputBuffer.getChannelData(0);
          const resampled = resampleFloat32(input, audioContext.sampleRate, TARGET_RATE);
          const level = rms(resampled);
          const now = performance.now();
          for (let i = 0; i < resampled.length; i += 1) samples.push(resampled[i]);
          if (level >= VAD_SPEECH_RMS) {
            if (!speechStartedAt) {
              speechStartedAt = now;
              // Telemetry-only signal (does not affect VAD thresholds/behavior):
              // lets the renderer log a vad_speech_started stage.
              onState('speech_started');
            }
            lastSpeechAt = now;
          }
          const spokenLongEnough = speechStartedAt && (now - speechStartedAt) >= VAD_MIN_SPEECH_MS;
          const silentLongEnough = lastSpeechAt && (now - lastSpeechAt) >= VAD_SILENCE_MS && level < VAD_SILENCE_RMS;
          if (spokenLongEnough && silentLongEnough) {
            onState('end_of_speech');
            const buf = audioContext.createBuffer(1, samples.length, TARGET_RATE);
            buf.copyToChannel(Float32Array.from(samples), 0);
            finish(encodeWavFromAudioBuffer(buf));
          }
        };
        source.connect(processor);
        const mute = audioContext.createGain();
        mute.gain.value = 0;
        processor.connect(mute);
        mute.connect(audioContext.destination);
        timeoutId = setTimeout(() => {
          if (stopped) return;
          if (samples.length < TARGET_RATE * 0.2) {
            finish(null);
            return;
          }
          const buf = audioContext.createBuffer(1, samples.length, TARGET_RATE);
          buf.copyToChannel(Float32Array.from(samples), 0);
          finish(encodeWavFromAudioBuffer(buf));
        }, MAX_UTTERANCE_MS);
      } catch (err) {
        cleanup();
        stopResolve(Promise.reject(err instanceof Error ? err : new Error(String(err))));
      }
    })();

    return {
      done,
      stop: async () => {
        if (stopped) return done;
        if (samples.length < TARGET_RATE * 0.15) {
          finish(null);
          return done;
        }
        const buf = (audioContext || new AudioContext({ sampleRate: TARGET_RATE }))
          .createBuffer(1, samples.length, TARGET_RATE);
        buf.copyToChannel(Float32Array.from(samples), 0);
        finish(encodeWavFromAudioBuffer(buf));
        return done;
      },
      cancel: () => {
        if (stopped) return;
        finish(null);
      },
    };
  }

  /**
   * Continuous mic for wake-word: emits Int16 PCM frames @ 16 kHz via onFrame.
   * Resamples from the real AudioContext rate (often 48 kHz on Windows).
   */
  function startWakeMonitor(opts = {}) {
    const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : () => undefined;
    const onLevel = typeof opts.onLevel === 'function' ? opts.onLevel : () => undefined;
    const onReady = typeof opts.onReady === 'function' ? opts.onReady : () => undefined;
    const onError = typeof opts.onError === 'function' ? opts.onError : () => undefined;
    let stream = null;
    let audioContext = null;
    let processor = null;
    let source = null;
    let stopped = false;
    const pending = [];
    let framesEmitted = 0;

    const cleanup = () => {
      try { processor?.disconnect(); } catch { /* ignore */ }
      try { source?.disconnect(); } catch { /* ignore */ }
      try { void audioContext?.close(); } catch { /* ignore */ }
      stream?.getTracks().forEach((track) => track.stop());
      processor = null;
      source = null;
      audioContext = null;
      stream = null;
    };

    void (async () => {
      try {
        stream = await getMicStream({ forWake: true });
        const track = stream.getAudioTracks()[0];
        const settings = track?.getSettings?.() || {};
        audioContext = new AudioContext({ sampleRate: TARGET_RATE });
        if (audioContext.state === 'suspended') await audioContext.resume();
        if (audioContext.state !== 'running') {
          throw new Error(`AudioContext not running (state=${audioContext.state}). Mic capture cannot feed the wake detector.`);
        }
        source = audioContext.createMediaStreamSource(stream);
        processor = audioContext.createScriptProcessor(4096, 1, 1);
        onReady({
          sampleRate: audioContext.sampleRate,
          contextState: audioContext.state,
          trackLabel: track?.label || '',
          trackSampleRate: settings.sampleRate || null,
          channelCount: settings.channelCount || null,
        });
        processor.onaudioprocess = (event) => {
          if (stopped) return;
          const input = event.inputBuffer.getChannelData(0);
          const level = rms(input);
          onLevel({
            rms: level,
            sampleRate: audioContext.sampleRate,
            framesEmitted,
          });
          const resampled = resampleFloat32(input, audioContext.sampleRate, TARGET_RATE);
          for (let i = 0; i < resampled.length; i += 1) pending.push(resampled[i]);
          while (pending.length >= WAKE_FRAME) {
            const frame = Float32Array.from(pending.splice(0, WAKE_FRAME));
            framesEmitted += 1;
            onFrame(floatToInt16(frame), {
              rms: rms(frame),
              sampleRate: TARGET_RATE,
              contextSampleRate: audioContext.sampleRate,
              framesEmitted,
            });
          }
        };
        source.connect(processor);
        const mute = audioContext.createGain();
        mute.gain.value = 0;
        processor.connect(mute);
        mute.connect(audioContext.destination);
      } catch (err) {
        cleanup();
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return {
      stop: () => {
        if (stopped) return;
        stopped = true;
        cleanup();
      },
    };
  }

  global.jarvisVoiceCapture = {
    startPushToTalkCapture,
    startVadUtteranceCapture,
    startWakeMonitor,
    bytesToBase64,
    floatToInt16,
    resampleFloat32,
    rms,
    MAX_UTTERANCE_MS,
    TARGET_RATE,
    WAKE_FRAME,
  };
}(window));
