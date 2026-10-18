import {readFile,writeFile} from 'node:fs/promises';
const at=new URL('./',import.meta.url);
const [style,learner,app]=await Promise.all(['style.css','learner.js','app.js'].map(x=>readFile(new URL(x,at),'utf8')));
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="description" content="AI 공부방의 시연·실습·도움·제출·복습을 체험하는 독립 HTML 목업"><title>공부방 · 수업 흐름 체험</title><style>${style}</style></head><body><div id="app"></div><div id="modal" hidden></div><div id="toast" class="toast" role="status" aria-live="polite"></div><input class="file-input" id="upload-input" type="file" accept=".txt,.md,.csv,.json,.log" aria-label="체험 공간에 텍스트 파일 열기"><script>${learner.replace(/<\/script/gi,'<\\/script')}</script><script>${app.replace(/<\/script/gi,'<\\/script')}</script></body></html>`;
await writeFile(new URL('index.html',at),html);
console.log('Built standalone classroom/index.html ('+Buffer.byteLength(html)+' bytes)');
