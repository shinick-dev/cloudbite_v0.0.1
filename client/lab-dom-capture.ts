// 이 랩 페이지의 현재 뷰포트만 픽셀로 떠서 MediaStream 으로 넘긴다.
// getDisplayMedia·화면 선택창은 쓰지 않는다. 다른 탭·데스크톱은 보지 않는다.
// 좌표는 이 문서 안에서만 끝나고, 원본 DOM·스크립트는 어디에도 보내지 않는다.
// 웹GL 터미널(xterm GPU)이 빈 캔버스로 찍히지 않게 하는 getContext 패치는
// LAB_DOM_CAPTURE_PRELUDE_JS 다. 코디네이터가 애플리케이션 스크립트보다 먼저 넣는다.

import { toCanvas } from 'html-to-image';

const ACTIVE_INTERVAL_MS = 500;
const IDLE_INTERVAL_MS = 1500;
const HIDDEN_INTERVAL_MS = 5000;
const MAX_INTERVAL_MS = 30000;
const MAX_OUTPUT_WIDTH = 1920;
const MAX_OUTPUT_HEIGHT = 1200;
// Copy visual/layout CSS, not hundreds of animation/print/scroll metadata
// properties per node. Huge foreignObject SVGs dominate full-HD render time.
const CAPTURE_STYLES = [
  'display', 'position', 'box-sizing', 'top', 'right', 'bottom', 'left',
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'margin', 'padding', 'border', 'border-radius', 'outline', 'outline-offset',
  'background', 'background-color', 'background-image', 'background-size', 'background-position', 'background-repeat',
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
  'list-style', 'border-collapse', 'table-layout', 'content', 'fill', 'stroke', 'stroke-width', 'd',
];

// 코디네이터가 code-server 터미널보다 먼저 이 페이지만에 주입하는 고전 스크립트.
// xterm WebGL 은 preserveDrawingBuffer 가 기본 false 라, 이후 캔버스 픽셀을 읽으면 빈 버퍼가 된다.
export const LAB_DOM_CAPTURE_PRELUDE_JS = "(function(){var proto=HTMLCanvasElement.prototype;var original=proto.getContext;if(!original||proto.__labDomCapturePrelude)return;proto.__labDomCapturePrelude=true;proto.getContext=function(type,attributes){var kind=typeof type===\"string\"?type:\"\";if(kind===\"webgl\"||kind===\"webgl2\"||kind===\"experimental-webgl\"||kind===\"experimental-webgl2\"){var next={};if(attributes){for(var key in attributes){if(Object.prototype.hasOwnProperty.call(attributes,key))next[key]=attributes[key];}}next.preserveDrawingBuffer=true;return original.call(this,type,next);}return original.call(this,type,attributes);};})();";

type CaptureQuality = 'preview' | 'detail';
interface OpenOptions {
  quality?: CaptureQuality;
  onError?: (error: unknown) => void;
}

interface CaptureSession {
  stream: MediaStream;
  stop: () => void;
  snapshot: () => HTMLCanvasElement;
  isCurrent: () => boolean;
  setQuality: (quality: CaptureQuality) => void;
  stats: () => { frames: number; renderMs: number; ageMs: number; quality: CaptureQuality };
}

declare global {
  interface HTMLCanvasElement {
    __labDomCapturePrelude?: boolean;
  }
  interface Window {
    __labDomCapture?: {
      open: (options?: OpenOptions) => Promise<CaptureSession>;
    };
    __labBarUI?: { box?: Element | null };
  }
}

let renderQueue: Promise<void> = Promise.resolve();

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(job, job);
  renderQueue = run.then(() => undefined, () => undefined);
  return run;
}

function outputSize(viewportWidth: number, viewportHeight: number, quality: CaptureQuality): { width: number; height: number } {
  const density = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const maxWidth = quality === 'preview' ? 640 : MAX_OUTPUT_WIDTH, maxHeight = quality === 'preview' ? 400 : MAX_OUTPUT_HEIGHT;
  const scale = Math.min(density, maxWidth / viewportWidth, maxHeight / viewportHeight);
  return {
    width: Math.max(1, Math.round(viewportWidth * scale)),
    height: Math.max(1, Math.round(viewportHeight * scale)),
  };
}

function scrollStyle(): Partial<CSSStyleDeclaration> {
  const x = window.scrollX || 0;
  const y = window.scrollY || 0;
  if (x === 0 && y === 0) return {};
  return {
    transform: `translate(${-x}px, ${-y}px)`,
    transformOrigin: 'top left',
  };
}

function crossOriginFrame(frame: HTMLIFrameElement): boolean {
  try {
    const doc = frame.contentDocument;
    if (doc) return doc.location.origin !== location.origin;
  } catch {
    return true;
  }
  const raw = frame.getAttribute('src');
  if (!raw || raw === 'about:blank') return false;
  try {
    const url = new URL(raw, location.href);
    return url.origin === 'null' || url.origin !== location.origin;
  } catch {
    return true;
  }
}

function keepNode(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return true;
  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'LINK' || tag === 'STYLE' || tag === 'META' || tag === 'BASE' || tag === 'TITLE') return false;
  if (el.hasAttribute('data-live-support') || el.closest('[data-live-support]')) return false;
  if (el.hasAttribute('data-lab-dom-capture')) return false;
  // html-to-image fetches an empty image src as the current HTML document,
  // then rejects the entire frame when that HTML cannot decode as an image.
  // code-server has such uninitialised placeholders in its workbench.
  if (tag === 'IMG' && !(el as HTMLImageElement).currentSrc && !el.getAttribute('src')?.trim() && !el.getAttribute('srcset')?.trim()) return false;
  // Do not echo the received meeting video back into the participant feed,
  // including its empty/hidden video element after the meeting share stops.
  if (el.matches('[data-lab="screen"]')) return false;
  const box = window.__labBarUI?.box;
  if (box && (el === box || box.contains(el))) return false;
  if (tag === 'IFRAME' && crossOriginFrame(el as HTMLIFrameElement)) return false;
  if (getComputedStyle(el).display === 'none') return false;
  return true;
}

function pageBackground(): string {
  for (const node of [document.documentElement, document.body]) {
    if (!node) continue;
    const color = getComputedStyle(node).backgroundColor;
    if (color && color !== 'transparent' && !/rgba\([^)]*,\s*0\s*\)/.test(color)) return color;
  }
  return '#ffffff';
}

async function rasterize(quality: CaptureQuality): Promise<HTMLCanvasElement> {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) || viewportWidth < 1 || viewportHeight < 1) {
    throw new Error('viewport unavailable');
  }
  const output = outputSize(viewportWidth, viewportHeight, quality);
  const snap = await toCanvas(document.documentElement, {
    backgroundColor: pageBackground(),
    width: viewportWidth,
    height: viewportHeight,
    canvasWidth: output.width,
    canvasHeight: output.height,
    pixelRatio: 1,
    skipFonts: true,
    includeStyleProperties: CAPTURE_STYLES,
    skipAutoScale: true,
    cacheBust: false,
    filter: ((node: Node) => keepNode(node)) as (domNode: HTMLElement) => boolean,
    style: scrollStyle(),
  });
  if (!(snap instanceof HTMLCanvasElement) || snap.width < 1 || snap.height < 1) {
    throw new Error('capture produced no canvas');
  }
  return snap;
}

function paint(target: HTMLCanvasElement, snap: HTMLCanvasElement): void {
  const context = target.getContext('2d');
  if (!context) throw new Error('canvas 2d context unavailable');
  if (target.width !== snap.width || target.height !== snap.height) {
    target.width = snap.width;
    target.height = snap.height;
  }
  context.clearRect(0, 0, target.width, target.height);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, target.width, target.height);
  context.drawImage(snap, 0, 0);
}

function hostError(onError: OpenOptions['onError'], error: unknown): void {
  try {
    onError?.(error);
  } catch {
    // 호스트 콜백이 캡처 루프를 멈추게 하지 않는다.
  }
}

export function installLabDomCapture(): void {
  window.__labDomCapture = {
    open: (options) => openCapture(options),
  };
}

async function openCapture(options?: OpenOptions): Promise<CaptureSession> {
  const frame = document.createElement('canvas');
  frame.setAttribute('data-lab-dom-capture', 'frame');
  frame.width = 1;
  frame.height = 1;
  let quality: CaptureQuality = options?.quality === 'preview' ? 'preview' : 'detail', paintedQuality = quality;
  let stopped = false;
  let painted = false;
  let timer = 0;
  let gap = IDLE_INTERVAL_MS;
  let running = false, dueAt = 0, activeUntil = 0, startedAt = 0, renderMs = 0, frames = 0;
  let paintedAt = 0, paintedWidth = 0, paintedHeight = 0;
  const render = async () => {
    const width = innerWidth, height = innerHeight;
    startedAt = performance.now();
    const requestedQuality = quality;
    const snap = await rasterize(requestedQuality);
    if (stopped) return;
    paint(frame, snap);
    paintedAt = performance.now(); paintedWidth = width; paintedHeight = height;
    renderMs = paintedAt - startedAt; paintedQuality = requestedQuality; frames++;
  };
  let stream: MediaStream | null = null;

  try {
    await enqueue(async () => {
      if (stopped) return;
      await render();
      painted = true;
    });
  } catch (error) {
    hostError(options?.onError, error);
    throw error instanceof Error ? error : new Error('lab dom capture failed');
  }
  if (!painted) throw new Error('lab dom capture produced no frame');
  try {
    if (typeof frame.captureStream !== 'function') throw new Error('canvas captureStream unavailable');
    // Emit on canvas changes: a 1fps cap adds up to a second after painting.
    stream = frame.captureStream();
  } catch (error) {
    hostError(options?.onError, error);
    throw error instanceof Error ? error : new Error('canvas captureStream unavailable');
  }

  // Keep one render in flight. New changes are coalesced; never queue old frames.
  const schedule = (delay: number) => {
    if (stopped) return;
    const due = performance.now() + delay;
    if (timer && due >= dueAt) return;
    window.clearTimeout(timer);
    dueAt = due;
    timer = window.setTimeout(() => { timer = 0; void tick(); }, delay);
  };
  const nextDelay = () => {
    const period = document.hidden ? HIDDEN_INTERVAL_MS : quality === 'preview' ? (performance.now() < activeUntil ? 1000 : 2000) : performance.now() < activeUntil ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS;
    // Start-to-start pacing, with at most ~50% render duty on slower computers.
    return Math.max(50, period - (performance.now() - startedAt), renderMs);
  };
  const wake = () => {
    if (stopped) return;
    activeUntil = performance.now() + 2500;
    if (!running && !document.hidden) schedule(Math.max(0, startedAt + Math.max(quality === 'preview' ? 1000 : ACTIVE_INTERVAL_MS, renderMs * 2) - performance.now()));
  };
  const changed = (event: Event) => {
    if (event.target instanceof Element && !keepNode(event.target)) return;
    wake();
  };
  const observer = new MutationObserver(records => {
    if (records.some(record => {
      const el = record.target instanceof Element ? record.target : record.target.parentElement;
      return el && keepNode(el);
    })) wake();
  });
  const events = ['input', 'keydown', 'pointerdown', 'wheel', 'scroll', 'resize', 'visibilitychange'] as const;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await enqueue(async () => {
        if (stopped) return;
        await render();
      });
      if (stopped) return;
      gap = nextDelay();
    } catch (error) {
      if (stopped) return;
      gap = Math.min(MAX_INTERVAL_MS, Math.max(IDLE_INTERVAL_MS, gap * 2));
      hostError(options?.onError, error);
    } finally { running = false; }
    schedule(gap);
  };
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'value', 'src'] });
  for (const event of events) window.addEventListener(event, changed, { capture: true, passive: true });
  schedule(nextDelay());

  return {
    stream,
    stop() {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(timer);
      timer = 0;
      observer.disconnect();
      for (const event of events) window.removeEventListener(event, changed, true);
      for (const track of stream?.getTracks() ?? []) track.stop();
    },
    snapshot() {
      return frame;
    },
    setQuality(next) {
      if (stopped || (next !== 'preview' && next !== 'detail') || next === quality) return;
      quality = next; wake();
    },
    stats() {
      return { frames, renderMs: Math.round(renderMs), ageMs: Math.round(performance.now() - paintedAt), quality: paintedQuality };
    },
    isCurrent() {
      return !stopped && paintedWidth === innerWidth && paintedHeight === innerHeight && performance.now() - paintedAt < 15000;
    },
  };
}
