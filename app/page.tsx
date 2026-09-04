'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Bot, Check, ChevronRight, CircleHelp, Clock3, FileImage, FolderOpen, Layers3, MoreHorizontal, Pause, Play, Plus, Settings2, Sparkles, Upload, X } from 'lucide-react';

type StageState = 'done' | 'working' | 'queued' | 'blocked';
type PipelineStep = { name: string; description: string; state: StageState; output: string; tool: string };

const initialSteps: PipelineStep[] = [
  { name: 'Persona Lock', description: '锁定角色特征与全身构图', state: 'done', output: 'base_v3.png', tool: '角色一致性 Skill' },
  { name: '状态图生成', description: '生成 5 个可驱动表情 / 待机状态', state: 'done', output: 'states_v2.zip', tool: '动作规划 Skill' },
  { name: '图层拆分', description: '将全身图拆为可绑定的 PSD 图层', state: 'working', output: 'seethrough_output.psd', tool: 'See-Through API' },
  { name: '图层质检', description: '检查遮挡、缺失层、透明边与嘴部层级', state: 'queued', output: 'qa_report.json', tool: 'QA 规则集' },
  { name: '网格绑定与动画', description: '自动映射骨架、生成网格并建立基础动作', state: 'queued', output: 'aira_rig.stretch', tool: 'Stretchy Studio · Auto-Rig' },
  { name: '预览验收', description: '验证口型、呼吸、转头与动作幅度', state: 'queued', output: 'preview_bundle.zip', tool: '验收脚本' },
];
const taskRows = [
  { id: 'L2D-024', name: '霓虹机甲 · 艾拉', state: '执行中', progress: 48, updated: '刚刚' },
  { id: 'L2D-023', name: '花店店主 · 米娅', state: '待验收', progress: 92, updated: '24 分钟前' },
  { id: 'L2D-022', name: '探险家 · 沈舟', state: '已交付', progress: 100, updated: '昨天' },
];
const nav = [{ label: '工作台', icon: Activity }, { label: '角色资产', icon: FolderOpen }, { label: '流程模板', icon: Layers3 }, { label: '运行记录', icon: Clock3 }];
const stateStyle: Record<StageState, { label: string; className: string }> = { done: { label: '已完成', className: 'status-done' }, working: { label: '运行中', className: 'status-working' }, queued: { label: '排队中', className: 'status-queued' }, blocked: { label: '需处理', className: 'status-blocked' } };

export default function Home() {
  const [steps, setSteps] = useState(initialSteps);
  const [isRunning, setIsRunning] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedNav, setSelectedNav] = useState('工作台');
  const [referenceFile, setReferenceFile] = useState('aira_reference.png');
  const fileInput = useRef<HTMLInputElement>(null);
  const progress = useMemo(() => Math.round(((steps.filter((step) => step.state === 'done').length + (steps.some((step) => step.state === 'working') ? .45 : 0)) / steps.length) * 100), [steps]);
  const advancePipeline = () => setSteps((current) => { const workingIndex = current.findIndex((step) => step.state === 'working'); if (workingIndex === -1) return current; return current.map((step, index) => index === workingIndex ? { ...step, state: 'done' } : index === workingIndex + 1 ? { ...step, state: 'working' } : step); });
  const toggleRun = () => { setIsRunning((running) => !running); if (!isRunning) advancePipeline(); };

  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: unknown, options?: { signal: AbortSignal }) => unknown } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: unknown) => Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined);
    void register({ name: 'open_live2d_task_creator', title: '新建 Live2D 任务', description: '打开角色任务创建表单，用于上传参考图并启动生成流程。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false }, execute: () => { setShowCreate(true); return { status: 'form_opened' }; } });
    void register({ name: 'get_live2d_pipeline_status', title: '查看 Live2D 流程状态', description: '读取当前角色任务的各阶段执行状态和整体进度。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: false }, execute: () => ({ progress, stages: steps.map(({ name, state, output }) => ({ name, state, output })) }) });
    return () => lifecycle.abort();
  }, [progress, steps]);

  return <main className="app-shell">
    <aside className="side-rail">
      <div className="brand-mark" aria-label="Live2D 工坊"><span className="brand-dot" /><span>morph</span></div>
      <button className="new-task" onClick={() => setShowCreate(true)}><Plus size={17} /> 新建任务</button>
      <nav className="main-nav" aria-label="主导航">{nav.map(({ label, icon: Icon }) => <button key={label} onClick={() => setSelectedNav(label)} className={selectedNav === label ? 'nav-item active' : 'nav-item'}><Icon size={18} />{label}</button>)}</nav>
      <div className="rail-footer"><button className="nav-item"><Settings2 size={18} />设置</button><div className="user-chip"><span>BR</span><div><b>包添荣</b><small>创作空间</small></div><MoreHorizontal size={17} /></div></div>
    </aside>
    <section className="workspace">
      <header className="topbar"><div className="crumbs"><span>工作台</span><ChevronRight size={14} /><b>角色生成</b></div><div className="top-actions"><button className="help"><CircleHelp size={18} /> 流程指南</button><button className="avatar">BR</button></div></header>
      <div className="workspace-scroll">
        <section className="intro-row"><div><p className="eyebrow">LIVE2D AUTOMATION</p><h1>角色生成工作台</h1><p className="intro-copy">从参考图到可交付的 Live2D 模型，把不稳定的制作步骤变成可追踪、可验收的流水线。</p></div><div className="header-actions"><button className="ghost-button"><FileImage size={17} />资产规范</button><button className="primary-button" onClick={() => setShowCreate(true)}><Plus size={17} />新建角色任务</button></div></section>
        <section className="overview-grid">
          <article className="feature-card current-task"><div className="card-top"><div><span className="task-id">L2D-024</span><h2>霓虹机甲 · 艾拉</h2></div><span className="live-pill"><i />运行中</span></div><div className="character-stage"><div className="scan-lines" /><div className="character-silhouette"><div className="halo" /><div className="head" /><div className="torso" /><div className="arm left" /><div className="arm right" /></div><div className="stage-label">角色预览 · v0.3</div></div><div className="progress-line"><div className="progress-copy"><span>全流程进度</span><b>{progress}%</b></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div></div><div className="task-meta"><span><Clock3 size={15} />预计还需 8 分钟</span><span><Bot size={15} />自动执行</span></div></article>
          <article className="feature-card stats-card"><div className="card-heading"><div><p className="eyebrow">本周概览</p><h2>生产节奏</h2></div><button aria-label="查看详情"><ArrowUpRight size={18} /></button></div><div className="stats"><div><strong>12</strong><span>创建任务</span></div><div><strong>8</strong><span>成功交付</span></div><div><strong>7.6</strong><span>平均质检分</span></div></div><div className="mini-chart" aria-label="近七日任务完成趋势"><span style={{height:'31%'}} /><span style={{height:'55%'}} /><span style={{height:'42%'}} /><span style={{height:'74%'}} /><span style={{height:'61%'}} /><span style={{height:'86%'}} /><span className="highlight" style={{height:'68%'}} /></div><div className="chart-labels"><span>周一</span><span>周二</span><span>周三</span><span>周四</span><span>周五</span><span>周六</span><span>今天</span></div></article>
        </section>
        <section className="pipeline-section"><div className="section-heading"><div><p className="eyebrow">PIPELINE</p><h2>自动化执行链路</h2></div><button className="run-button" onClick={toggleRun}>{isRunning ? <><Pause size={16} />暂停流程</> : <><Play size={16} />继续并推进</>}</button></div><div className="pipeline">{steps.map((step, index) => { const status = stateStyle[step.state]; return <article className={`pipeline-step ${step.state}`} key={step.name}><div className="step-number">{step.state === 'done' ? <Check size={15} /> : String(index + 1).padStart(2, '0')}</div><div className="step-content"><div className="step-title"><h3>{step.name}</h3><span className={status.className}>{status.label}</span></div><p>{step.description}</p><div className="step-footer"><span>{step.tool}</span><b>{step.output}</b></div></div></article>; })}</div></section>
        <section className="bottom-grid"><article className="table-card"><div className="section-heading compact"><div><p className="eyebrow">RECENT RUNS</p><h2>最近任务</h2></div><button className="text-button">查看全部 <ChevronRight size={15} /></button></div><div className="task-table"><div className="table-head"><span>任务</span><span>状态</span><span>进度</span><span>更新时间</span></div>{taskRows.map((task) => <div className="table-row" key={task.id}><div><b>{task.name}</b><small>{task.id}</small></div><span className={`task-state ${task.state === '已交付' ? 'delivered' : task.state === '待验收' ? 'review' : ''}`}>{task.state}</span><div className="row-progress"><span><i style={{width:`${task.progress}%`}} /></span><b>{task.progress}%</b></div><time>{task.updated}</time></div>)}</div></article><article className="risk-card"><div className="risk-icon"><Sparkles size={19} /></div><p className="eyebrow">今日建议</p><h2>优先处理嘴部图层</h2><p>现有测试中，口型张合与面部遮挡是最常见的失败点。将“嘴部 / 牙齿 / 口腔”设为拆层必检项。</p><button className="text-button">打开质检规则 <ArrowUpRight size={15} /></button></article></section>
      </div>
    </section>
    {showCreate && <div className="modal-backdrop" role="presentation"><section className="create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title"><button className="close-modal" onClick={() => setShowCreate(false)} aria-label="关闭"><X size={20} /></button><p className="eyebrow">CREATE PIPELINE RUN</p><h2 id="create-title">新建角色任务</h2><p className="modal-copy">提交一张角色参考图，系统会从全身角色底图开始依次执行生成、拆层、绑定与验收。</p><label className="field-label">角色名称<input defaultValue="未命名角色" /></label><label className="field-label">角色参考图<button className="upload-box" type="button" onClick={() => fileInput.current?.click()}><Upload size={21} /><span>{referenceFile}</span><small>PNG / JPG，建议正脸或半身角色图</small></button><input ref={fileInput} className="hidden-input" type="file" accept="image/*" onChange={(event) => setReferenceFile(event.target.files?.[0]?.name || 'aira_reference.png')} /></label><div className="modal-actions"><button className="ghost-button" onClick={() => setShowCreate(false)}>取消</button><button className="primary-button" onClick={() => { setShowCreate(false); setSelectedNav('工作台'); }}>创建并开始执行 <ArrowUpRight size={16} /></button></div></section></div>}
  </main>;
}
