// 시연실 .class-demo 루트만 픽셀로 떠 1920×1080 MediaStream 으로 넘긴다.
// 문서 전체·브라우저 화면 선택·다른 탭은 쓰지 않는다. 원본 DOM 은 읽기만 한다.
// 글자·스크롤 보정은 html-to-image 클론 안에서만 일어나고, 화면을 다른 캔버스 글자로 다시 그리지 않는다.

import { toCanvas } from 'html-to-image';

const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;
const FRAME_MS = 250;
const IDENTITY_MS = 50;

// 레이아웃·전경·배경색만 복사한다. background-image·list-style-image·mask-image 와
// 그 단축 속성은 url() 을 가져오므로 목록에 넣지 않는다. Chromium 은 cssText 로
// 이 목록을 건너뛰므로, 번들 패치가 클론 CSS 의 url() 을 지운다.
const CAPTURE_STYLES = [
  'display', 'position', 'box-sizing', 'top', 'right', 'bottom', 'left',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'padding', 'border', 'border-color', 'border-width', 'border-style', 'border-radius',
  'outline', 'outline-offset', 'outline-color', 'outline-style', 'outline-width',
  'background-color',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch',
  'font-feature-settings', 'font-variation-settings', 'font-kerning', 'line-height', 'letter-spacing', 'word-spacing',
  'white-space', 'word-break', 'overflow-wrap', 'text-align', 'text-decoration', 'text-indent', 'text-transform',
  'text-overflow', 'text-rendering', 'text-shadow', 'vertical-align', 'tab-size', 'direction', 'writing-mode', 'unicode-bidi',
  'flex', 'flex-direction', 'flex-wrap', 'flex-basis', 'flex-grow', 'flex-shrink', 'order',
  'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items', 'justify-self', 'gap',
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-auto-columns', 'grid-auto-rows',
  'grid-auto-flow', 'grid-column', 'grid-row',
  'visibility', 'opacity', 'z-index', 'overflow', 'overflow-x', 'overflow-y', 'clip', 'clip-path',
  'transform', 'transform-origin', 'box-shadow', 'object-fit', 'object-position', 'image-rendering', 'appearance',
  'list-style-type', 'list-style-position', 'border-collapse', 'table-layout', 'fill', 'stroke', 'stroke-width', 'd',
];

const DENIED_TAGS = new Set([
  'SCRIPT', 'NOSCRIPT', 'STYLE', 'LINK', 'META', 'BASE', 'TITLE',
  'IFRAME', 'OBJECT', 'EMBED', 'IMG', 'IMAGE', 'VIDEO', 'AUDIO', 'CANVAS', 'SOURCE', 'SVG', 'USE',
]);

export interface LabDemoBroadcastOptions {
  root: () => HTMLElement | null;
  selected: () => string | null;
  authorized: () => boolean;
  onError?: (error: unknown) => void;
}

export interface LabDemoBroadcastSession {
  stream: MediaStream;
  stop: () => void;
  isCurrent: () => boolean;
  stats: () => { frames: number; renderMs: number; ageMs: number; width: number; height: number };
}

export interface LabDemoBroadcastFactory {
  open: (roomId: string) => Promise<LabDemoBroadcastSession>;
}

declare global {
  interface Window {
    createLabDemoBroadcast?: (options: LabDemoBroadcastOptions) => LabDemoBroadcastFactory;
  }
}

let renderQueue: Promise<void> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(job, job);
  renderQueue = run.then(() => undefined, () => undefined);
  return run;
}

function hostError(onError: LabDemoBroadcastOptions['onError'], error: unknown): void {
  try {
    onError?.(error);
  } catch {
    // 호스트 콜백이 정리 경로를 다시 열지 않게 한다.
  }
}

function readRoot(options: LabDemoBroadcastOptions): HTMLElement | null {
  const root = options.root();
  return root instanceof HTMLElement ? root : null;
}

function identityOk(options: LabDemoBroadcastOptions, roomId: string, root: HTMLElement | null): root is HTMLElement {
  if (!root || !root.isConnected) return false;
  if (!root.classList.contains('class-demo')) return false;
  if (root.getAttribute('data-demo-room') !== roomId) return false;
  try {
    if (options.selected() !== roomId) return false;
    if (options.authorized() !== true) return false;
  } catch {
    return false;
  }
  return true;
}

function keepNode(node: Node, root: HTMLElement, roomId: string): boolean {
  if (node.nodeType === Node.TEXT_NODE) return true;
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (DENIED_TAGS.has(tag)) return false;
  if (tag === 'INPUT' && (el as HTMLInputElement).type.toLowerCase() === 'password') return false;
  const marker = el.closest('[data-demo-private],[data-lab-admin]');
  if (marker && marker !== root && root.contains(marker)) return false;
  if (el.classList.contains('class-demo')) return false;
  const room = el.getAttribute('data-demo-room');
  if (room !== null && room !== roomId) return false;
  return true;
}

function backgroundOf(node: HTMLElement): string {
  const color = getComputedStyle(node).backgroundColor;
  if (color && color !== 'transparent' && !/rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(color)) return color;
  return '#000000';
}

function paintFrame(context: CanvasRenderingContext2D, snap: HTMLCanvasElement): void {
  const scale = Math.min(OUTPUT_WIDTH / snap.width, OUTPUT_HEIGHT / snap.height);
  const dw = Math.max(1, Math.round(snap.width * scale));
  const dh = Math.max(1, Math.round(snap.height * scale));
  const dx = Math.round((OUTPUT_WIDTH - dw) / 2);
  const dy = Math.round((OUTPUT_HEIGHT - dh) / 2);
  context.clearRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
  context.fillStyle = '#000000';
  context.fillRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(snap, dx, dy, dw, dh);
}

export function installLabDemoBroadcast(): void {
  window.createLabDemoBroadcast = (options) => ({
    open: (roomId) => openBroadcast(options, roomId),
  });
}

async function openBroadcast(options: LabDemoBroadcastOptions, roomId: string): Promise<LabDemoBroadcastSession> {
  if (typeof roomId !== 'string' || roomId.length === 0) {
    const error = new Error('demo room unavailable');
    hostError(options.onError, error);
    throw error;
  }
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_WIDTH;
  canvas.height = OUTPUT_HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    const error = new Error('canvas 2d context unavailable');
    hostError(options.onError, error);
    throw error;
  }
  context.clearRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);

  let stopped = false;
  let painted = false;
  let failure: Error | null = null;
  let stream: MediaStream | null = null;
  let timer = 0;
  let poll = 0;
  let frames = 0;
  let renderMs = 0;
  let paintedAt = 0;
  let paintedRoot: HTMLElement | null = null;
  let rendering = false;

  const clearCanvas = () => {
    context.clearRect(0, 0, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    paintedRoot = null;
  };
  const halt = () => {
    if (stopped) return;
    stopped = true;
    window.clearTimeout(timer);
    timer = 0;
    window.clearInterval(poll);
    poll = 0;
    window.removeEventListener('pagehide', onPageHide);
    clearCanvas();
    for (const track of stream?.getTracks() ?? []) track.stop();
  };
  const failIdentity = () => {
    if (stopped) return;
    failure = new Error('demo room is not active');
    halt();
    if (stream) hostError(options.onError, failure);
  };
  const onPageHide = () => halt();
  const currentRoot = (): HTMLElement | null => {
    try {
      return readRoot(options);
    } catch {
      return null;
    }
  };
  const watchIdentity = () => {
    if (stopped) return;
    if (stream?.getVideoTracks().some(track => track.readyState === 'ended')) {
      halt();
      hostError(options.onError, new Error('demo video track ended'));
      return;
    }
    if (!identityOk(options, roomId, currentRoot())) failIdentity();
  };

  const renderFrame = async (retry: boolean): Promise<void> => {
    if (stopped) return;
    const root = currentRoot();
    if (!identityOk(options, roomId, root)) {
      failIdentity();
      return;
    }
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new Error('demo root has no layout');
    }
    const backgroundColor = backgroundOf(root);
    const snap = await toCanvas(root, {
      backgroundColor,
      width,
      height,
      canvasWidth: width,
      canvasHeight: height,
      pixelRatio: 1,
      skipFonts: true,
      fontEmbedCSS: '',
      skipAutoScale: true,
      cacheBust: false,
      includeStyleProperties: CAPTURE_STYLES,
      filter: ((node: Node) => keepNode(node, root, roomId)) as (domNode: HTMLElement) => boolean,
    });
    if (stopped) return;
    const latest = currentRoot();
    if (!identityOk(options, roomId, latest)) {
      failIdentity();
      return;
    }
    // 같은 방의 새 .class-demo 가 오면 방금 뜬 이전 노드는 그리지 않는다.
    if (latest !== root) {
      if (retry && !stopped) await renderFrame(false);
      return;
    }
    if (!(snap instanceof HTMLCanvasElement) || snap.width < 1 || snap.height < 1) {
      throw new Error('demo broadcast produced no canvas');
    }
    paintFrame(context, snap);
    if (stopped || !identityOk(options, roomId, currentRoot())) {
      failIdentity();
      return;
    }
    paintedRoot = root;
    paintedAt = performance.now();
    frames += 1;
    painted = true;
  };

  const runRender = async (retry: boolean) => {
    if (stopped || rendering) return;
    rendering = true;
    const started = performance.now();
    try {
      await renderFrame(retry);
      if (!stopped) renderMs = performance.now() - started;
    } finally {
      rendering = false;
    }
  };

  const loop = async () => {
    if (stopped || rendering) return;
    const started = performance.now();
    try {
      await enqueue(async () => {
        if (!stopped) await runRender(false);
      });
    } catch (error) {
      if (stopped) return;
      halt();
      hostError(options.onError, error);
      return;
    }
    if (stopped) return;
    const wait = document.hidden ? 1500 : Math.max(FRAME_MS, Math.min(1000, performance.now() - started));
    timer = window.setTimeout(() => {
      timer = 0;
      void loop();
    }, wait);
  };

  window.addEventListener('pagehide', onPageHide);
  poll = window.setInterval(watchIdentity, IDENTITY_MS);
  try {
    await enqueue(async () => {
      if (!stopped) await runRender(true);
    });
    if (stopped || !painted) throw failure ?? new Error('demo broadcast stopped before the first frame');
    if (typeof canvas.captureStream !== 'function') throw new Error('canvas captureStream unavailable');
    stream = canvas.captureStream(15);
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('canvas captureStream unavailable');
    track.addEventListener('ended', () => halt());
    const wait = Math.max(FRAME_MS, Math.min(1000, renderMs));
    timer = window.setTimeout(() => {
      timer = 0;
      void loop();
    }, wait);
    return {
      stream,
      stop() {
        halt();
      },
      isCurrent() {
        if (stopped || !paintedRoot) return false;
        const root = currentRoot();
        return root === paintedRoot && identityOk(options, roomId, root);
      },
      stats() {
        return {
          frames,
          renderMs: Math.round(renderMs),
          ageMs: paintedAt ? Math.round(performance.now() - paintedAt) : 0,
          width: OUTPUT_WIDTH,
          height: OUTPUT_HEIGHT,
        };
      },
    };
  } catch (error) {
    const wrapped = error instanceof Error ? error : new Error('demo broadcast failed');
    halt();
    hostError(options.onError, wrapped);
    throw wrapped;
  }
}
