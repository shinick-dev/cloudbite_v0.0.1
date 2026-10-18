// The operator's running lesson uses the viewport. Forms retain their own scroll.
export const LAB_COMMAND_CENTER_CSS = String.raw`
#runBar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;grid-area:bar}
#runBar h2{margin:0}#runActions{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
#runBar button,#runBar summary,#workspaceTabs button{width:auto;min-height:44px;padding:8px 12px}
#workspaceTabs{display:flex;align-items:center;gap:8px;grid-area:tabs;flex-wrap:wrap}
#workspaceTabs [aria-pressed=true]{background:var(--acc);color:#fff;border-color:transparent}
#workspaceStatus{margin:0;font-weight:600}#broadcastDock{margin-left:auto}
#workspaceQueue{font-size:13px;font-weight:600;color:var(--bad)}
#demoWorkspace{grid-area:stage;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
#demoWorkspace[hidden]{display:none!important}#demoWorkspace>header{display:flex;align-items:center;gap:8px;padding:8px 12px;flex-wrap:wrap;flex:none}
#demoWorkspaceStatus{flex:1;min-width:180px;font-size:13px;margin:0}#demoWorkspace header button{width:auto;min-height:40px;padding:6px 10px;font-size:13px}
#demoWorkspaceModes .class-card{padding:0;margin:0;border:0;background:none}#demoWorkspaceModes .class-card>p{display:none}#demoWorkspaceModes .class-row{margin:0;gap:4px}
#demoWorkspaceFrame{position:relative;flex:1;min-height:200px;overflow:hidden;background:#101418}#demoWorkspaceFrame iframe{border:0;background:#18212f;transform-origin:top left}#demoWorkspaceFrame [data-demo-status]{position:absolute;inset:16px;color:#e6e9ef}#demoWorkspaceFrame:has(iframe) [data-demo-status]{display:none}
#viewRun[data-demo-mounted=on][data-workspace=home] #classMain{display:none!important}
#demoWorkspace[data-parked=true]{position:fixed;left:-100000px;top:0;width:1920px;height:1124px;pointer-events:none}
#demoWorkspace:fullscreen{width:100vw;height:100vh;border:0;border-radius:0;background:var(--bg)}
.broadcast-other{position:relative;font-size:12px}.broadcast-other summary{cursor:pointer;min-height:36px;display:flex;align-items:center}.broadcast-other[open]>button{position:absolute;right:0;top:100%;min-width:160px;z-index:5;background:var(--card);color:var(--fg);border:1px solid var(--line)}
#broadcastDock button{width:auto;min-height:44px;padding:8px 12px}
#broadcastDock p{margin:4px 0;font-size:12px}
#labNav{justify-content:flex-end}
#broadcastPreviewStage{grid-area:stage;min-width:0;min-height:0;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:12px;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
#broadcastPreviewStage[hidden]{display:none!important}#broadcastPreviewStage header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}#broadcastPreviewStage header>div{display:flex;gap:6px}
#broadcastPreviewStage button{width:auto;min-height:40px;padding:6px 10px;font-size:13px}#broadcastPreviewStage p{margin:0;font-size:12px;overflow-wrap:anywhere}
#broadcastPreviewVideo{display:block;width:100%;height:100%;min-height:0;flex:1 1 auto;object-fit:contain;background:#10151d;border-radius:6px}
#viewRun[data-broadcast=large] #classMain,#viewRun[data-broadcast=large] #supportStage{display:none}
#viewRun[data-broadcast=small]:not([data-workspace=home]) #broadcastPreviewStage{display:none}
#broadcastPreviewStage[data-size=small]{width:min(34%,340px);justify-self:end;align-self:start;z-index:2;gap:4px;padding:8px}#broadcastPreviewStage[data-size=small] video{height:auto;aspect-ratio:16/9;flex:none}#broadcastPreviewStage[data-size=small] header{font-size:12px}#broadcastPreviewStage[data-size=small] header>div{flex-wrap:wrap}#broadcastPreviewStage[data-size=small] .mut{display:none}
#broadcastPreviewStage:fullscreen{width:100vw;height:100vh;border:0;border-radius:0;padding:20px;align-self:stretch}#broadcastPreviewStage:fullscreen video{height:100%;flex:1;min-height:0;aspect-ratio:auto}
.utility-dialog .utility-action{width:auto;min-height:40px;padding:8px 12px}
#supportStage{grid-area:stage;min-width:0;min-height:0;display:none}
#viewRun[data-workspace=support] #classMain{display:none}
#viewRun[data-workspace=support] #supportStage{display:block}
#viewRun[data-workspace=gallery] #classMain{display:none}
#viewRun[data-workspace=gallery] #supportStage{display:block}
#viewRun[data-demo-capture=on]:not([data-workspace=home]) #classMain{display:block!important;position:fixed;left:-100000px;top:0;width:var(--demo-source-width,1400px);height:var(--demo-source-height,700px);pointer-events:none;overflow:auto}
#classMain:fullscreen,#supportStage:fullscreen{box-sizing:border-box;background:var(--bg);padding:20px;width:100vw;height:100vh;overflow:auto}
#viewRun[data-demo-size=large] .demo-file-editor textarea{height:clamp(260px,40dvh,640px)!important;font-size:16px!important}
#classMain:fullscreen .demo-file-editor textarea{height:55dvh!important;font-size:18px!important}
#supportStage>.lab-live-root{box-sizing:border-box;height:100%;overflow:auto;margin:0}
#supportStage>.lab-live-root .lab-live-grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr))}
#supportStage>.lab-live-root .lab-live-seat{height:auto}
#supportStage>.lab-live-root video{max-height:220px;aspect-ratio:16/9}
#supportStage .lab-live-seat{padding:12px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
#supportStage video{display:block;width:100%;max-height:48vh;object-fit:contain;background:#141413}
#supportStage button{width:auto;min-height:44px;padding:8px 12px}
#supportStage .lab-live-primary,#supportStage .lab-live-tools{display:flex;gap:8px;flex-wrap:wrap}
#supportStage .lab-live-support{margin-top:8px}#supportStage textarea{box-sizing:border-box;max-width:100%}
#supportStage .lab-live-consent{font-weight:600}#supportStage .lab-live-consent[data-kind=active]{color:var(--ok)}
#supportStage .lab-live-consent[data-kind=unknown],#supportStage .lab-live-consent[data-kind=expired]{color:var(--bad)}
#supportStage p{margin:6px 0}#supportStage details:not([open])>:not(summary){display:none!important}
#supportStage .lab-live-seat[hidden]{display:none!important}
#runGuide{grid-area:guide;min-width:0}#runGuide .class-card{margin:0;padding:12px 16px;border-top:1px solid var(--line)}
#runGuide h2{margin:0 0 6px}#runGuide p{margin:4px 0}#runGuide button{width:auto;min-height:44px}
#runGuide .class-step-context{font-size:13px;color:var(--mut)}
#runGuide .class-prompt{margin:4px 0;max-height:92px;overflow:auto}
#classNotices:empty,#classNote:empty{display:none}#classNotices{grid-area:notice}#classNotices p{margin:0}
#opsDialog{box-sizing:border-box;width:min(1120px,96vw);max-height:90dvh;padding:20px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:12px;overflow:auto}
#opsDialog::backdrop{background:#0008}#opsDialog:not([open]){display:none}
#opsDialog .ops-heading{position:sticky;top:-20px;z-index:2;background:var(--bg);display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0}
#opsDialog .ops-heading h2{margin:0}#opsDialog .ops-heading button{width:auto;min-height:44px}
.utility-dialog{box-sizing:border-box;width:min(880px,96vw);max-height:90dvh;overflow:auto;padding:20px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:12px}
.utility-dialog.utility-small{width:min(520px,94vw)}
.utility-dialog:not([open]){display:none}.utility-dialog::backdrop{background:#0006}
.utility-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.utility-heading h2{margin:0;font-size:18px}.utility-heading button{width:auto;min-height:44px;padding:8px 12px}
.utility-dialog p{overflow-wrap:anywhere}.utility-dialog .row>button{flex:1 1 180px;width:auto}
.utility-dialog #viewSet>.card{margin:8px 0;padding:12px}.utility-dialog #instCard{font-size:13px}
#labNav .nav-utility{flex:none;width:auto;min-height:40px;padding:6px 12px;font-size:13px;background:transparent;color:var(--mut);border-color:transparent}
#labNav .nav-utility:hover,#labNav .nav-utility[aria-expanded=true]{background:var(--card);color:var(--fg);border-color:var(--line)}
#requestPreviews{margin:8px 0 12px;padding-bottom:10px;border-bottom:1px solid var(--line)}
.request-preview-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.request-preview-head h3{flex:1;margin:0;font-size:13px}
.request-preview-head button,.request-preview-head a{width:auto;min-height:36px;padding:6px;font-size:12px}.request-preview-head a{color:var(--mut)}
.request-preview-note{font-size:12px;margin:4px 0;overflow-wrap:anywhere}.request-preview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;max-height:300px;overflow:auto;overscroll-behavior:contain}
.request-preview{min-width:0}.request-preview>h3{font-size:13px;margin:6px 0}.request-preview-screen{height:64px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:var(--line);border-radius:8px;color:var(--fg);padding:8px;box-sizing:border-box;text-align:center;font-size:12px}
.request-preview[data-waiting=true] .request-preview-screen{animation:request-waiting 2.8s ease-in-out infinite}
@keyframes request-waiting{0%,100%{background:var(--line)}50%{background:var(--card)}}
.request-preview-purpose{font-size:12px;margin:4px 0;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.request-preview-brief,.request-preview-status{font-size:12px;margin:4px 0;overflow-wrap:anywhere}.request-preview-status:empty{display:none}
.request-preview>button{width:100%;min-height:44px;margin:4px 0;padding:8px 6px;font-size:13px}.request-preview details{font-size:12px}#requestPreviews summary{font-size:12px;min-height:28px;padding:0}
.request-preview label{display:block;font-size:12px;margin:6px 0}.request-preview input,.request-preview select{box-sizing:border-box;width:100%;min-width:0;max-width:100%;font-size:12px;padding:6px}.request-preview-custom{display:grid;grid-template-columns:1fr;gap:4px}
@media(prefers-reduced-motion:reduce){.request-preview[data-waiting=true] .request-preview-screen{animation:none}}
@media(max-width:460px){.request-preview-grid{grid-template-columns:1fr}}
.lab-live-progress{font-size:12px;color:var(--mut);margin:4px 0}
.lab-live-home{padding:8px;border:1px solid var(--acc);border-radius:8px;min-width:0}
.lab-live-home button{width:100%;min-height:44px}.lab-live-home p{margin:4px 0;font-size:13px}
.live-metrics{font-size:12px}.live-metrics summary{font-weight:400}
.class-demo-work{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;min-width:0}
.class-demo{max-width:1920px;margin-inline:auto!important}.class-demo-commands .class-text{max-height:240px;overflow:auto}
.class-demo-commands{min-width:0}.class-demo-commands>button{width:auto}
@media(min-width:1200px) and (min-height:700px){
 body.lab-command-run{height:100dvh;overflow:hidden}
 body.lab-command-run main{box-sizing:border-box;max-width:none;height:100dvh;padding:12px 20px;margin:0;display:grid;grid-template-columns:minmax(200px,1fr) auto;grid-template-rows:auto minmax(0,1fr) auto;grid-template-areas:"title nav" "panel panel" "message message";gap:8px 16px}
 body.lab-command-run main>h1{grid-area:title;font-size:18px;margin:0;align-self:center}
 body.lab-command-run #labNav{grid-area:nav;margin:0;gap:4px}
 body.lab-command-run #labNav button,body.lab-command-run #labNav a{flex:none;padding:6px 16px;font-size:13px;min-height:40px}
 body.lab-command-run #labNav .nav-utility{padding:6px 10px;color:var(--mut)}
 body.lab-command-run #panel{grid-area:panel;display:flex;flex-direction:column;min-height:0}
 body.lab-command-run #roomHead{flex:none;margin:0 0 8px;align-items:center}
 body.lab-command-run #roomHead .who{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
 body.lab-command-run #roomSelect{width:min(360px,30vw);margin:0;padding:8px}
 body.lab-command-run #roomHead .room-notes{display:flex;gap:12px;font-size:12px}
 body.lab-command-run #roomHead .auth{font-size:12px}
 body.lab-command-run #msg{grid-area:message;margin:0;max-height:60px;overflow:auto;font-size:13px}
 body.lab-command-run #msg:empty{display:none}
 body.lab-command-run #viewRun{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) clamp(360px,22vw,640px);grid-template-rows:auto auto minmax(0,1fr) auto auto;grid-template-areas:"bar bar" "tabs rail" "stage rail" "notice rail" "guide rail";gap:8px 16px;align-items:stretch}
 body.lab-command-run #viewRun[data-demo-mounted=on][data-demo-size=large]{grid-template-columns:minmax(0,1fr) 320px}
 body.lab-command-run #viewRun[data-demo-mounted=on][data-demo-size=large] #runBar{display:none}
 body.lab-command-run #viewRun[data-demo-mounted=on][data-demo-size=large] #runGuide .class-prompt{display:none}
 body.lab-command-run #runBar{min-width:0;flex-wrap:nowrap}
 body.lab-command-run #viewRunH{font-size:13px;white-space:nowrap}
 body.lab-command-run #classSide{background:transparent;border:0;padding:0;display:flex;align-items:center;gap:12px;min-width:0}
 body.lab-command-run #classSide nav{display:flex;flex-direction:row;gap:4px}
 body.lab-command-run #classSide nav button{font-size:13px;padding:8px;white-space:nowrap}
 body.lab-command-run #classSide>p{display:none}
 body.lab-command-run #classSide>details{position:relative;font-size:13px}
 body.lab-command-run #classSide>details[open] .class-steps{position:absolute;top:44px;left:0;z-index:5;width:260px;max-height:50dvh;overflow:auto;padding:8px;background:var(--bg);border:1px solid var(--line);border-radius:12px;box-shadow:0 8px 24px #0002}
 body.lab-command-run #workspaceTabs{min-height:44px;align-self:start}
 body.lab-command-run #classMain{grid-area:stage;overflow:auto;overscroll-behavior:contain;min-height:0;padding:0 2px}
 body.lab-command-run #viewRun[data-broadcast=small][data-workspace=home] #classMain{padding-right:min(36%,352px);box-sizing:border-box}
 body.lab-command-run #classMain>.class-card{margin:0 0 8px}
 body.lab-command-run #classMain>.class-card:first-child{padding:8px 12px}
 body.lab-command-run #classMain>.class-card:first-child p{font-size:12px;margin:4px 0 0}
 body.lab-command-run #classMain .class-demo{display:flex;flex-direction:column;min-height:0}
 body.lab-command-run #classMain .class-demo h2{margin:0;font-size:16px}
 body.lab-command-run #classMain .class-demo>p{margin:4px 0;font-size:13px}
 body.lab-command-run #classMain .class-demo .class-field{margin:4px 0}
 body.lab-command-run #classMain .class-demo .class-field textarea{height:64px;width:100%;box-sizing:border-box}
 body.lab-command-run #classMain .class-demo .demo-file-editor{margin:8px 0}
 body.lab-command-run #classMain .class-demo .demo-file-editor textarea{height:clamp(140px,17dvh,480px)}
 body.lab-command-run #classMain .class-demo-work{align-items:start}
 body.lab-command-run #supportStage{overflow:auto;overscroll-behavior:contain}
 body.lab-command-run #supportStage .lab-live-seat{height:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;overflow:auto}
 body.lab-command-run #supportStage h3{margin:0;font-size:16px}
 body.lab-command-run #supportStage video{flex:1 1 160px;min-height:120px;max-height:none;aspect-ratio:auto;margin:0}
 body.lab-command-run #supportStage .lab-live-support{display:flex;gap:4px 12px;flex-wrap:wrap;align-items:center;flex:none}
 body.lab-command-run #supportStage .lab-live-support form{display:flex;gap:8px;align-items:center;width:100%;margin:0}
 body.lab-command-run #supportStage .lab-live-support form label{flex:1;min-width:0;font-size:12px}
 body.lab-command-run #supportStage .lab-live-support textarea{flex:1;min-width:0;height:56px}
 body.lab-command-run #supportStage .lab-live-support p,body.lab-command-run #supportStage .lab-live-state{font-size:13px;margin:0}
 body.lab-command-run #supportStage .lab-live-support [hidden]{display:none!important}
 body.lab-command-run #classRail{grid-area:rail;min-height:0;display:flex;flex-direction:column;gap:8px}
 body.lab-command-run #classRail .work{display:contents}
 body.lab-command-run #classRail #handsBar{order:-1;max-height:230px;overflow:auto;margin:0;padding:10px 12px;flex:none}
 body.lab-command-run #handsBar[data-hands="0"]{max-height:88px}
 body.lab-command-run #handsBar[data-hands="0"] #handList,body.lab-command-run #handsBar[data-hands="0"] #handHistory,body.lab-command-run #handsBar>p.mut:not(#handRo){display:none}
 body.lab-command-run #handList{max-height:none;margin:4px 0}body.lab-command-run #handHistory{font-size:12px}
 body.lab-command-run #handList li{padding:4px 0;gap:4px 8px;font-size:12px}body.lab-command-run #handList .mut{display:none}
 body.lab-command-run #handList button{padding:6px 8px;font-size:12px}
 body.lab-command-run #handsBar h2{font-size:14px}
 body.lab-command-run #liveTools{flex:1;min-height:0;overflow:auto;margin:0;padding:10px 12px}
 body.lab-command-run #liveTools>p[role=status]{margin:0;font-size:13px;font-weight:600}
 body.lab-command-run #liveTools .lab-live-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:start}
 body.lab-command-run #liveTools .lab-live-seat{padding:8px 0 0;border-width:1px;outline-offset:-2px}
 body.lab-command-run #liveTools .lab-live-seat h3{font-size:13px;line-height:1.4;margin:0;overflow-wrap:anywhere}
 body.lab-command-run #liveTools .lab-live-state{font-size:12px;margin:2px 0}
 body.lab-command-run #liveTools .lab-live-seat video{max-height:100px;margin:4px 0;aspect-ratio:16/9}
 body.lab-command-run #liveTools .lab-live-primary{margin:4px 0}
 body.lab-command-run #liveTools .lab-live-primary button{font-size:12px;padding:6px 8px;width:100%}
 body.lab-command-run #liveTools .lab-live-primary button:not(.sec){background:transparent;color:var(--fg);border:1px solid var(--line)}
 body.lab-command-run #liveTools .lab-live-primary button:first-child{display:none}
 body.lab-command-run #liveTools .lab-live-seat>details{display:none}
 body.lab-command-run #liveTools .lab-live-seat>p[role=status]:empty{display:none}
 body.lab-command-run #classPeople{overflow:auto;min-height:0;margin:0}
 body.lab-command-run #deliveryDock{padding:0;margin:0;border:0;background:transparent;max-width:440px;flex:none}
 body.lab-command-run #deliveryDock [data-lab-control]{display:flex;gap:4px;align-items:center}
 body.lab-command-run #deliveryDock [data-lab-control]>strong,body.lab-command-run #deliveryDock [data-lab-control]>p:not(.bad){display:none}
 body.lab-command-run #deliveryDock .row{flex:none;gap:4px;margin:0}
 body.lab-command-run #deliveryDock .row>button{flex:none!important;width:auto;font-size:12px;padding:8px}
 body.lab-command-run #deliveryDock .row>button:last-child{display:none}
 body.lab-command-run #broadcastDock p.mut{display:none}
 body.lab-command-run #runGuide .class-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 16px;max-height:190px;overflow:auto;box-sizing:border-box;background:var(--card)}
 body.lab-command-run #runGuide .class-card>h2,body.lab-command-run #runGuide .class-card>.class-prompt,body.lab-command-run #runGuide .class-card>p{grid-column:1}
 body.lab-command-run #runGuide .class-row{grid-column:2;grid-row:1/5;align-self:center;margin:0}
 body.lab-command-run #runGuide .class-card>p:last-child{display:none}
 body.lab-command-run #runGuide .class-prompt{max-height:64px;padding:8px;font-size:13px}
 body.lab-command-run #runGuide h2{font-size:16px}body.lab-command-run #runGuide p{font-size:13px}
 body.lab-command-run #runGuide .class-step-context{display:none}
 body.lab-command-run #workspaceTabs #workspaceHome[aria-pressed=true]{background:#e8edff;color:#2447c6;border:1px solid #c9d4ff}
 body.lab-command-run #shareHold{position:fixed;bottom:12px;left:20px;z-index:8;max-width:440px;background:var(--bg)}
}
@media(max-width:1199px),(max-height:699px){
 .class-demo-work{grid-template-columns:minmax(0,1fr)}
 #viewRun:not([hidden]){display:flex;flex-direction:column;gap:12px}
 #runBar,#classSide,#classRail,#classMain,#supportStage,#runGuide,#classNotices{width:100%;box-sizing:border-box}
 #classSide nav{flex-direction:row;flex-wrap:wrap}#classSide>details{margin-top:8px}
 #classSide nav button{flex:1 1 auto}#runActions{margin-left:0}
 #classRail,#classRail .work{display:contents}#handsBar{order:1}#liveTools,#classPeople{order:5}#runGuide{order:4}#classNotices{order:3}
 #workspaceTabs{order:2}#classMain,#supportStage{order:3}
 #broadcastPreviewStage{order:3;width:100%;min-height:240px}#broadcastPreviewStage[data-size=small]{width:min(100%,340px);min-height:0}#broadcastPreviewStage[data-size=large] video{height:auto;aspect-ratio:16/9;flex:none}
 #classRail #liveTools .lab-live-grid{grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))}
 #runGuide .class-card{max-height:none}#opsDialog{padding:12px}
}
`;
