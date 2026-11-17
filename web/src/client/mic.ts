// Microphone: capture -> Opus (WebCodecs) -> server, which feeds the VM's microphone.
import { Bin, cmd } from '../protocol';
import type { App } from './app';
import { el } from './app';

const RATE = 48000;

export function createMic(app: App) {
	const btn = el<HTMLButtonElement>('mic-btn');
	let wanted = true;
	let available = false;
	let starting: AbortController | null = null;
	let on = false;
	let stream: MediaStream | null = null;
	let ctx: AudioContext | null = null;
	let enc: AudioEncoder | null = null;
	let ts = 0;

	function show() {
		btn.classList.toggle('on', on);
		btn.setAttribute('aria-pressed', String(on));
		if (!btn.classList.contains('err'))
			btn.title = on || starting ? 'Turn microphone off' : 'Turn microphone on';
		// While the mic is live the toolbar stays up as a recording indicator.
		app.tools.classList.toggle('mic-on', on);
	}

	function setup(enabled: boolean) {
		const wasAvailable = available;
		available = enabled && !!navigator.mediaDevices?.getUserMedia;
		app.tools.classList.toggle('mic', available);
		if (!available) release();
		else if (!wasAvailable && wanted) void start();
	}

	async function opusEncoder(): Promise<AudioEncoder | null> {
		if (typeof AudioEncoder === 'undefined') return null;
		const base: AudioEncoderConfig = {
			codec: 'opus',
			sampleRate: RATE,
			numberOfChannels: 1,
			bitrate: 32000,
		};
		const voip = {
			...base,
			opus: { frameDuration: 20000, application: 'voip' },
		} as AudioEncoderConfig;
		// Try the VoIP-tuned config first, then the plain one, in order.
		for (const config of [voip, base]) {
			try {
				// oxlint-disable-next-line no-await-in-loop
				if (!(await AudioEncoder.isConfigSupported(config)).supported) continue;
				const e = new AudioEncoder({
					output: (chunk) => {
						const b = new Uint8Array(chunk.byteLength);
						chunk.copyTo(b);
						app.sendBin(Bin.MicOpus, b);
					},
					error: (err) => console.warn('[voxl] microphone encoder', err),
				});
				e.configure(config);
				return e;
			} catch {}
		}
		return null;
	}

	function onChunk(f: Float32Array) {
		if (!on) return;
		if (enc && enc.state === 'configured') {
			const data = new AudioData({
				format: 'f32-planar',
				sampleRate: RATE,
				numberOfFrames: f.length,
				numberOfChannels: 1,
				timestamp: ts,
				data: f,
			});
			ts += 20000;
			enc.encode(data);
			data.close();
		} else {
			// No WebCodecs audio encoder (older Safari/Firefox): send 16-bit PCM.
			const pcm = new Int16Array(f.length);
			for (let i = 0; i < f.length; i++)
				pcm[i] = Math.max(-1, Math.min(1, f[i])) * 32767;
			app.sendBin(Bin.MicPcm, new Uint8Array(pcm.buffer));
		}
	}

	async function start() {
		if (!available || starting || on) return;
		const attempt = new AbortController();
		starting = attempt;
		btn.classList.remove('err');
		show();
		try {
			const capture = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
				},
			});
			if (attempt.signal.aborted) {
				capture.getTracks().forEach((track) => track.stop());
				return;
			}
			stream = capture;
			const context = new AudioContext({
				sampleRate: RATE,
				latencyHint: 'interactive',
			});
			ctx = context;
			await context.audioWorklet.addModule('mic.js');
			if (attempt.signal.aborted) return;
			const encoder = await opusEncoder();
			if (attempt.signal.aborted) {
				encoder?.close();
				return;
			}
			enc = encoder;
			const node = new AudioWorkletNode(context, 'mic-capture', {
				numberOfInputs: 1,
				numberOfOutputs: 0,
				channelCount: 1,
				channelCountMode: 'explicit',
			});
			node.port.addEventListener('message', (e: MessageEvent<Float32Array>) =>
				onChunk(e.data)
			);
			node.port.start();
			context.createMediaStreamSource(capture).connect(node);
			if (context.state !== 'running') await context.resume();
			if (attempt.signal.aborted) return;
			on = true;
			app.send(cmd.mic(true));
		} catch (err) {
			if (attempt.signal.aborted) return;
			console.warn('[voxl] microphone unavailable', err);
			release();
			btn.classList.add('err');
			btn.title =
				err instanceof DOMException && err.name === 'NotAllowedError'
					? 'Microphone access was blocked'
					: 'No microphone available';
		} finally {
			if (starting === attempt) starting = null;
			show();
		}
	}

	function release() {
		starting?.abort();
		starting = null;
		if (on) app.send(cmd.mic(false));
		on = false;
		stream?.getTracks().forEach((t) => t.stop());
		ctx?.close().catch(() => {});
		if (enc && enc.state !== 'closed') {
			try {
				enc.close();
			} catch {}
		}
		stream = null;
		ctx = null;
		enc = null;
		show();
	}

	function stop() {
		wanted = false;
		release();
	}

	function resumeOnInteraction() {
		if (ctx?.state === 'suspended') void ctx.resume().catch(() => {});
	}

	window.addEventListener('pointerup', resumeOnInteraction);
	window.addEventListener('keydown', resumeOnInteraction);
	btn.addEventListener('click', () => {
		if (on || starting) stop();
		else {
			wanted = true;
			void start();
		}
	});
	return { setup, stop };
}
