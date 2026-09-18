// Development-only harness: same production component, no login changes or model redistribution.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeRuntimeViewer } from '../../src/NativeRuntimeViewer';
import '../../src/production.css';
import { readAsset, saveAsset, saveAssets } from '../../src/assets';

function Harness() {
  const [name, setName] = useState(localStorage.getItem('morph-runtime-qa-name') || '');
  const [visible, setVisible] = useState(true);
  return <main style={{ padding: 20, maxWidth: 1100, margin: 'auto' }}>
    <h1>工作流原生预览组件回归</h1><p>使用正式组件和独立的本机测试缓存，不修改工作台任务。</p>
    <button onClick={() => setVisible(!visible)}>{visible ? '关闭预览组件' : '重新打开预览组件'}</button>
    {visible && <NativeRuntimeViewer savedPackageName={name} loadSavedPackage={async () => (await readAsset('runtime-workflow-qa-prepared')) ?? readAsset('runtime-workflow-qa-only')}
      savePreparedPackage={file => saveAsset('runtime-workflow-qa-prepared', file)}
      savePackage={async file => { await saveAssets([{ key: 'runtime-workflow-qa-only', value: file }, { key: 'runtime-workflow-qa-prepared', value: file }]); localStorage.setItem('morph-runtime-qa-name', file.name); setName(file.name); }} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
