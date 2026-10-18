import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Settings } from './state';
import { t } from './i18n.ts';

/** `native` shares frames through Syphon (macOS) or Spout2 (Windows); `browser` serves PNG frames to an OBS browser source. */
export type ObsMode = Settings['obsOutput'];
// Keep in sync with src-tauri/src/texture.rs.
const NATIVE_WIDTH = 1920;
const NATIVE_HEIGHT = 1080;

export interface ObsFrameSource {
  transparentCanvas(): HTMLCanvasElement;
  transparentPixels(width: number, height: number): Uint8Array;
}

function nativeOutput(): 'Syphon' | 'Spout2' | undefined {
  if (!isTauri()) return;
  if (/Mac/.test(navigator.platform)) return 'Syphon';
  if (/Win/.test(navigator.platform)) return 'Spout2';
}

export class ObsOutput {
  readonly state = {
    supported: isTauri(),
    native: nativeOutput(),
    active: false,
    pending: false,
    url: '',
    /** Milliseconds spent rendering and reading the last native frame, and in its round trip. */
    captureMs: 0,
    transferMs: 0,
    /** Empty round trips: the Tauri IPC channel and the local HTTP server, for comparison. */
    pingMs: 0,
    httpPingMs: 0,
  };
  private control: Promise<void> = Promise.resolve();
  /** Base URL of the local server that accepts native frames over `POST /frame`. */
  private nativeUrl = '';
  private frame?: Promise<void>;
  private running?: ObsMode;
  private revision = 0;
  private lastFrame = -Infinity;
  // Whether a Syphon client or a polling OBS page is attached; frames are not produced for nobody.
  private wanted = true;

  constructor(
    private changed: () => void,
    private report: (message: string) => void,
  ) {}

  setEnabled(enabled: boolean, mode: ObsMode = 'browser'): Promise<void> {
    if (!this.state.supported) return Promise.reject(new Error(t('obs.needsDesktop')));
    if (!this.state.native) mode = 'browser';
    const revision = ++this.revision;
    this.state.active = false;
    this.state.pending = true;
    this.changed();
    this.control = this.control
      .catch(() => {})
      .then(async () => {
        // Drain the encoder/IPC before stopping so a late frame cannot restart the source.
        await this.frame;
        if (this.running && !(enabled && this.running === mode)) {
          await invoke(this.running === 'native' ? 'texture_stop' : 'obs_stop');
          this.running = undefined;
        }
        if (!enabled) return;
        const url = mode === 'native' ? '' : await invoke<string>('obs_start');
        if (mode === 'native') {
          this.nativeUrl = await invoke<string>('texture_start');
          await this.measure();
        }
        this.running = mode;
        if (revision === this.revision) {
          this.state.url = url;
          this.state.active = true;
          this.lastFrame = -Infinity;
          this.wanted = true;
        }
      })
      .finally(() => {
        if (revision === this.revision) {
          this.state.pending = false;
          this.changed();
        }
      });
    return this.control;
  }

  /**
   * Times an empty round trip on both channels. The IPC figure is what the app used before frames
   * moved to the local server, so the two numbers show what the switch bought.
   */
  private async measure(): Promise<void> {
    try {
      const start = performance.now();
      await invoke('texture_ping', new Uint8Array(1024));
      this.state.pingMs = Math.round(performance.now() - start);
    } catch {
      this.state.pingMs = 0;
    }
    try {
      const start = performance.now();
      const response = await fetch(new URL('frame', this.nativeUrl), { cache: 'no-store' });
      // A rejected origin answers just as fast, so only a 2xx proves the channel works.
      this.state.httpPingMs = response.ok ? Math.round(performance.now() - start) : -1;
    } catch {
      this.state.httpPingMs = 0;
    }
  }

  submit(source: ObsFrameSource, width = NATIVE_WIDTH, height = NATIVE_HEIGHT): void {
    const now = performance.now();
    const native = this.running === 'native';
    const idle = !this.wanted;
    // Native frames follow the render loop. PNG encoding is capped at 30 FPS, with slack for a
    // 30 FPS render loop whose ticks land slightly early. Without a receiver, only poll for one.
    if (
      !this.state.active ||
      this.state.pending ||
      this.frame ||
      now - this.lastFrame < (idle ? 250 : native ? 0 : 1000 / 30 - 4)
    )
      return;
    this.lastFrame = now;
    const revision = this.revision;
    this.frame = (async () => {
      if (idle) {
        this.wanted = await invoke<boolean>(native ? 'texture_wanted' : 'obs_wanted');
        return;
      }
      if (native) {
        const captureStart = performance.now();
        const pixels = source.transparentPixels(width, height);
        this.state.captureMs = performance.now() - captureStart;
        const start = performance.now();
        // Local HTTP instead of `invoke`: the Tauri IPC channel costs a fixed ~96 ms per round
        // trip here regardless of payload, while this path measured ~46 ms for a 720p frame.
        try {
          const response = await fetch(new URL('frame', this.nativeUrl), {
            method: 'POST',
            body: pixels.buffer as ArrayBuffer,
            cache: 'no-store',
          });
          if (!response.ok) throw new Error(await response.text());
          this.wanted = true;
        } catch {
          // Fall back to IPC so a server that failed to bind cannot stop the output outright.
          this.wanted = await invoke<boolean>('texture_submit', pixels);
        }
        this.state.transferMs = performance.now() - start;
        return;
      }
      // ponytail: PNG readback/encoding caps throughput; the native mode avoids it.
      const blob = await new Promise<Blob>((resolve, reject) => {
        source
          .transparentCanvas()
          .toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error(t('obs.encodeFailed')))),
            'image/png',
          );
      });
      const bytes = await blob.arrayBuffer();
      if (this.state.active && revision === this.revision)
        this.wanted = await invoke<boolean>('obs_submit', bytes);
    })()
      .catch((error) => {
        if (revision !== this.revision) return;
        this.report(t('obs.outputFailed', { error: String(error) }));
        void this.setEnabled(false).catch((failure) => this.report(String(failure)));
      })
      .finally(() => {
        this.frame = undefined;
      });
  }

  destroy(): void {
    if (this.state.supported) void this.setEnabled(false).catch(() => {});
  }
}
