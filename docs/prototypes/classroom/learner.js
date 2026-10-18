window.renderLearner = function (S, H) {
  const p = S.students.find(x => x.id === S.learnerId);
  const e = H.esc;
  if (!p) {
    return '<section class="page-head"><h1 class="page-title">참여자를 찾지 못했습니다</h1><p class="muted">명단에서 참여자를 고른 뒤 다시 열어 주세요.</p></section>';
  }

  const mine = H.stepData(p.step) || {};
  const teacher = H.stepData(S.step) || {};
  const step = Math.max(0, Math.min(4, p.step | 0));
  const tStep = Math.max(0, Math.min(4, S.step | 0));
  const modes = {
    watch: ['따라 보기', 'blue', '시연은 모임지기 실습실에서 실행됩니다. 내 파일은 바뀌지 않아요.'],
    together: ['함께 하기', 'amber', '함께 실행은 고른 참여자만, 확인한 뒤에 각자 실습실에서 따로 실행합니다.'],
    practice: ['혼자 실습', 'green', '참여자가 자기 실습실에서 따로 작업합니다.']
  };
  const mode = modes[S.mode] || modes.practice;
  const sub = p.submission;
  const btn = (action, cls, label, extra) =>
    '<button type="button" class="btn ' + cls + '" data-action="' + action + '"' + (extra || '') + '>' + label + '</button>';
  const idAttr = ' data-id="' + e(p.id) + '"';
  let consent = '';
  if (p.consent === 'requested') {
    consent = '<div class="consent-banner notice"><p>모임지기가 내 실습실의 클릭·키보드 제어를 요청했습니다. 화면 미리보기는 이미 연결돼 있으며, 제어는 내가 허용해야 시작합니다.</p><div class="head-actions">'
      + btn('consent-allow', 'primary small', '5분 동안 제어 허용', idAttr)
      + btn('consent-deny', 'danger small', '거절', idAttr)
      + '</div></div>';
  } else if (p.consent === 'active') {
    consent = '<div class="consent-banner notice"><p>모임지기가 내 실습실을 제어할 수 있습니다. 언제든 제어를 끝내고 직접 작업할 수 있어요.</p>'
      + btn('consent-end', 'secondary small', H.icon('close') + ' 제어 끝내기', idAttr)
      + '</div>';
  }

  let feedback = '';
  if (sub && sub.feedback) {
    feedback = '<div class="feedback-box"><p class="section-head">모임지기 의견</p><p>' + e(sub.feedback) + '</p>'
      + (sub.version == null ? '' : '<p class="muted">제출 차례 ' + e(String(sub.version)) + '</p>')
      + '<p class="hint">모임지기의 의견입니다. 다음 단계는 참여자가 고릅니다.</p></div>';
  } else if (sub) {
    feedback = '<p class="hint">제출한 내용이 있습니다. 모임지기 의견은 아직 없습니다.</p>';
  }

  const on = (value) => (p.status === value ? ' active' : '');
  const stat = (value, label) => btn('status', 'ghost small' + on(value), label, ' data-value="' + value + '"');
  const stage = S.showDemo ? (H.teacherPreview() || '') : (H.editor(p) || '');
  const here = S.showDemo ? '모임지기 시연' : '내 실습실';
  const other = S.showDemo ? '내 실습실' : '모임지기 시연';
  const who = [S.classTitle, p.name].filter(Boolean).map(e).join(' · ');

  return '<header class="page-head"><div>'
    + '<h1 class="page-title">내 손으로 완성하는 5줄 보고서</h1>'
    + '<p class="muted">' + who + ' · 사실(신청 10명)과 제안·미정(정원 12명 검토 중, 40분 제안, 참가비 미정)을 구분합니다.</p>'
    + '</div><div class="head-actions">' + btn('show-materials', 'secondary', H.icon('book') + ' 자료 보기') + '</div></header>'
    + '<div class="live-layout"><div class="workspace-column">'
    + '<div class="lesson-strip"><span class="pill blue">모임지기 ' + (tStep + 1) + '/5</span>'
    + '<strong>' + e(teacher.title || '') + '</strong>'
    + '<span class="lesson-action"><span class="workspace-meta">지금 ' + here + '</span>'
    + btn('toggle-demo', 'secondary small', H.icon(S.showDemo ? 'code' : 'screen') + ' ' + other, ' aria-pressed="' + (S.showDemo ? 'true' : 'false') + '"')
    + '</span></div>'
    + '<p class="inline-note"><span class="pill ' + mode[1] + '">' + mode[0] + '</span> ' + mode[2]
    + (S.paused ? ' <span class="pill amber">잠시 멈춤</span>' : '') + '</p>'
    + '<section class="learner-stage"><div class="workspace-head"><div class="workspace-meta">참여자 단계 '
    + (step + 1) + '/5 · ' + e(mine.title || '') + '</div><div class="head-actions">'
    + btn('upload', 'ghost small', H.icon('upload') + ' 올리기')
    + btn('download', 'ghost small', H.icon('download') + ' 내려받기')
    + btn('save', 'secondary small', H.icon('check') + ' 저장')
    + '</div></div>' + stage + '</section></div>'
    + '<aside class="side-panel">' + consent
    + '<section class="panel"><div class="panel-heading">이 단계 안내</div><div class="step-content">'
    + '<h2>' + e(mine.title || '') + '</h2>'
    + '<p class="section-head">이번 목표</p><p>' + e(mine.goal || '') + '</p>'
    + '<p class="section-head">예시 문장</p><div class="prompt-block"><pre>' + e(mine.prompt || '') + '</pre></div>'
    + '<div class="head-actions">'
    + btn('copy-prompt', 'ghost small', H.icon('copy') + ' 예시 문장 복사')
    + btn('insert-prompt', 'secondary small', H.icon('arrow') + ' 실습실에 넣기')
    + btn('generate', 'secondary small', H.icon('code') + ' 내 초안 만들기')
    + btn('bookmark', 'ghost small', H.icon('book') + ' 남겨 두기', ' data-value="' + step + '"')
    + '</div></div><div class="divider"></div><div class="head-actions">'
    + btn('learner-step', 'secondary small', '이전 단계', ' data-value="' + (step <= 0 ? 0 : step - 1) + '"' + (step <= 0 ? ' disabled' : ''))
    + btn('learner-step', 'secondary small', '다음 단계', ' data-value="' + (step >= 4 ? 4 : step + 1) + '"' + (step >= 4 ? ' disabled' : ''))
    + '</div></section>'
    + '<section class="panel"><div class="panel-heading">내 상태</div><div class="quick-status">'
    + stat('working', '작업 중')
    + stat('needs-time', '시간 더 필요')
    + stat('done', '마친 것으로 표시')
    + '</div>'
    + btn('help', 'secondary' + on('help'), H.icon('help') + ' 도움 요청')
    + (p.helpText ? '<p class="hint">' + e(p.helpText) + '</p>' : '')
    + btn('submit', 'primary', H.icon('send') + ' 제출')
    + feedback
    + '</section></aside></div>';
};
